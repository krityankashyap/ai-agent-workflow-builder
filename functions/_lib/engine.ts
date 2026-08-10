// The resumable execution engine. ONE function, runFrom(runId, startIndex),
// drives a workflow run:
//   - triggerWorkflowRun calls it with startIndex = 0
//   - approveStep (M3) calls it with the saved resume index after an approval
//
// Every status transition is persisted to step_runs / workflow_runs as it
// happens, so the GraphQL subscription reflects progress live. All state lives
// in the DB — there is no in-memory continuation.
import { adminGql } from "./hasura";
import {
  Context,
  runConditionalBranch,
  runHttpRequest,
  runLlmCall,
  withRetry,
} from "./steps";

interface Step {
  id: string;
  position: number;
  type: string;
  config: any;
}

const nowIso = () => new Date().toISOString();

// Create a run and pre-create a `pending` step_run for every step (so the live
// subscription shows the whole pipeline immediately). Shared by every trigger
// type (manual now; webhook/scheduled/event later).
export async function createRun(
  workflowId: string,
  orgId: string,
  opts: { triggeredBy?: string | null; triggerType: string }
): Promise<string> {
  const stepsData = await adminGql<{
    workflow_steps: { id: string; position: number; type: string }[];
  }>(
    `query ($wf: uuid!) {
       workflow_steps(where: { workflow_id: { _eq: $wf } }, order_by: { position: asc }) {
         id position type
       }
     }`,
    { wf: workflowId }
  );

  const runData = await adminGql<{ insert_workflow_runs_one: { id: string } }>(
    `mutation ($obj: workflow_runs_insert_input!) {
       insert_workflow_runs_one(object: $obj) { id }
     }`,
    {
      obj: {
        workflow_id: workflowId,
        org_id: orgId,
        status: "pending",
        resume_index: 0,
        triggered_by: opts.triggeredBy ?? null,
        trigger_type: opts.triggerType,
      },
    }
  );
  const runId = runData.insert_workflow_runs_one.id;

  const objects = stepsData.workflow_steps.map((s) => ({
    run_id: runId,
    step_id: s.id,
    position: s.position,
    step_type: s.type,
    status: "pending",
  }));
  if (objects.length > 0) {
    await adminGql(
      `mutation ($objs: [step_runs_insert_input!]!) {
         insert_step_runs(objects: $objs) { affected_rows }
       }`,
      { objs: objects }
    );
  }
  return runId;
}

export async function runFrom(
  runId: string,
  startIndex: number
): Promise<{ status: string }> {
  const { steps, stepRunIdByPos, priorOutputs } = await loadRun(runId);

  // Rebuild context from steps that already succeeded (needed when resuming).
  const ctx: Context = { steps: {}, prev: null };
  for (const pos of Object.keys(priorOutputs).map(Number)) {
    if (pos < startIndex) {
      ctx.steps[pos] = priorOutputs[pos];
      ctx.prev = priorOutputs[pos];
    }
  }

  await setRunStatus(runId, "running");

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    const stepRunId = stepRunIdByPos[step.position];
    ctx.prev = i > 0 ? ctx.steps[i - 1] ?? ctx.prev : null;

    // approval_gate: pause here and hand control back. The run resumes at i via
    // approveStep after an owner/editor approves (Layer 2, re-checked in M3).
    if (step.type === "approval_gate") {
      await updateStepRun(stepRunId, {
        status: "awaiting_approval",
        started_at: nowIso(),
      });
      await pauseRun(runId, i);
      return { status: "paused" };
    }

    await updateStepRun(stepRunId, {
      status: "running",
      started_at: nowIso(),
      attempt: 1,
    });

    try {
      let output: any;
      let attempt = 1;

      if (step.type === "llm_call") {
        const r = await withRetry(() => runLlmCall(step.config, ctx));
        output = r.result;
        attempt = r.attempts;
      } else if (step.type === "http_request") {
        const r = await withRetry(() => runHttpRequest(step.config, ctx));
        output = r.result;
        attempt = r.attempts;
      } else if (step.type === "conditional_branch") {
        output = runConditionalBranch(step.config, ctx);
      } else if (step.type === "db_write" || step.type === "notify") {
        // Full behavior lands in M6; succeed as a no-op so runs don't break.
        output = { note: `${step.type} executed (stub — full impl in M6)` };
      } else {
        throw new Error(`Unknown step type: ${step.type}`);
      }

      await updateStepRun(stepRunId, {
        status: "succeeded",
        output,
        attempt,
        finished_at: nowIso(),
      });
      ctx.steps[i] = output;
      ctx.prev = output;

      // Branch side-effect: when the condition is false, either skip the next
      // step or stop the run early — this is what "changes behavior based on the
      // LLM output" looks like in a run.
      if (step.type === "conditional_branch" && output.condition === false) {
        if (output.if_false === "stop") {
          await completeRun(runId, "succeeded");
          return { status: "succeeded" };
        }
        const next = steps[i + 1];
        if (next) {
          await updateStepRun(stepRunIdByPos[next.position], {
            status: "skipped",
            finished_at: nowIso(),
          });
          i++; // advance past the skipped step
        }
      }
    } catch (err: any) {
      await updateStepRun(stepRunId, {
        status: "failed",
        error: String(err?.message ?? err),
        attempt: err?.attempts ?? 1,
        finished_at: nowIso(),
      });
      await completeRun(runId, "failed", String(err?.message ?? err));
      return { status: "failed" };
    }
  }

  await completeRun(runId, "succeeded");
  return { status: "succeeded" };
}

// --- data access ------------------------------------------------------------

async function loadRun(runId: string): Promise<{
  orgId: string;
  steps: Step[];
  stepRunIdByPos: Record<number, string>;
  priorOutputs: Record<number, any>;
}> {
  const data = await adminGql<{
    workflow_runs_by_pk: {
      org_id: string;
      workflow: { steps: Step[] };
      step_runs: { id: string; position: number; status: string; output: any }[];
    } | null;
  }>(
    `query ($id: uuid!) {
       workflow_runs_by_pk(id: $id) {
         org_id
         workflow { steps(order_by: { position: asc }) { id position type config } }
         step_runs(order_by: { position: asc }) { id position status output }
       }
     }`,
    { id: runId }
  );
  const run = data.workflow_runs_by_pk;
  if (!run) throw new Error(`Run ${runId} not found`);

  const stepRunIdByPos: Record<number, string> = {};
  const priorOutputs: Record<number, any> = {};
  for (const sr of run.step_runs) {
    stepRunIdByPos[sr.position] = sr.id;
    if (sr.status === "succeeded") priorOutputs[sr.position] = sr.output;
  }
  return { orgId: run.org_id, steps: run.workflow.steps, stepRunIdByPos, priorOutputs };
}

async function setRunStatus(runId: string, status: string): Promise<void> {
  await adminGql(
    `mutation ($id: uuid!, $status: String!) {
       update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: { status: $status }) { id }
     }`,
    { id: runId, status }
  );
}

async function updateStepRun(id: string, set: Record<string, any>): Promise<void> {
  await adminGql(
    `mutation ($id: uuid!, $set: step_runs_set_input!) {
       update_step_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id }
     }`,
    { id, set }
  );
}

async function pauseRun(runId: string, resumeIndex: number): Promise<void> {
  await adminGql(
    `mutation ($id: uuid!, $ri: Int!) {
       update_workflow_runs_by_pk(
         pk_columns: { id: $id }
         _set: { status: "paused", resume_index: $ri }
       ) { id }
     }`,
    { id: runId, ri: resumeIndex }
  );
}

// Terminal completion: set status + finished_at, then increment the org's quota
// usage exactly once (a completed run consumed resources whether it succeeded or
// failed). Paused runs are NOT terminal, so they don't increment here.
async function completeRun(
  runId: string,
  status: string,
  error?: string
): Promise<void> {
  const data = await adminGql<{
    update_workflow_runs_by_pk: { org_id: string };
  }>(
    `mutation ($id: uuid!, $status: String!, $error: String, $fin: timestamptz!) {
       update_workflow_runs_by_pk(
         pk_columns: { id: $id }
         _set: { status: $status, error: $error, finished_at: $fin }
       ) { org_id }
     }`,
    { id: runId, status, error: error ?? null, fin: nowIso() }
  );
  const orgId = data.update_workflow_runs_by_pk.org_id;
  await adminGql(
    `mutation ($orgId: uuid!) {
       update_organizations_by_pk(pk_columns: { id: $orgId }, _inc: { quota_used: 1 }) { id }
     }`,
    { orgId }
  );
}
