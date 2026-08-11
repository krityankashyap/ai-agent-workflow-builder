// Typed GraphQL operations for the UI. The four operations the assignment calls
// out are marked (a)–(d).
import { run } from "./graphql";

export type Role = "owner" | "editor" | "viewer";
export const canEdit = (r?: Role | null) => r === "owner" || r === "editor";
export const canRun = (r?: Role | null) => r === "owner" || r === "editor";
export const isOwner = (r?: Role | null) => r === "owner";

export const STEP_TYPES = [
  "llm_call",
  "http_request",
  "conditional_branch",
  "approval_gate",
  "db_write",
  "notify",
] as const;
export type StepType = (typeof STEP_TYPES)[number];
// Layer-2: only an owner may create these (the DB enforces it too).
export const OWNER_ONLY_STEP_TYPES: StepType[] = ["db_write", "notify"];

export const TRIGGER_TYPES = ["manual", "webhook", "scheduled", "database_event"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export interface Org {
  id: string;
  name: string;
  plan: string;
  quota_limit: number;
  quota_used: number;
}
export interface Membership {
  role: Role;
  organization: Org;
}
export interface Step {
  id?: string;
  position: number;
  type: StepType;
  config: any;
}
export interface Trigger {
  id: string;
  type: TriggerType;
  config: any;
  enabled: boolean;
}
export interface Run {
  id: string;
  status: string;
  trigger_type: string | null;
  started_at: string;
  finished_at: string | null;
}
export interface StepRun {
  id: string;
  position: number;
  step_type: string;
  status: string;
  input: any;
  output: any;
  error: string | null;
  attempt: number;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

// (a) — an org's memberships with quota (used for the org switcher + quota badge).
export async function getMemberships(): Promise<Membership[]> {
  const d = await run<{ org_members: Membership[] }>(`
    query MyMemberships {
      org_members(order_by: { organization: { name: asc } }) {
        role
        organization { id name plan quota_limit quota_used }
      }
    }
  `);
  return d.org_members;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  steps: { id: string }[];
  triggers: { id: string; type: string }[];
  runs: { id: string; status: string; started_at: string }[];
}

// (a) — an org's workflows with steps, triggers, and most recent run status.
// (We count steps client-side; Hasura aggregate fields require allow_aggregations.)
export async function getWorkflows(orgId: string): Promise<WorkflowSummary[]> {
  const d = await run<{ workflows: WorkflowSummary[] }>(
    `query OrgWorkflows($orgId: uuid!) {
       workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
         id name description
         steps { id }
         triggers { id type }
         runs(order_by: { started_at: desc }, limit: 1) { id status started_at }
       }
     }`,
    { orgId }
  );
  return d.workflows;
}

export interface WorkflowDetail {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  steps: Step[];
  triggers: Trigger[];
  runs: Run[];
}

export async function getWorkflow(id: string): Promise<WorkflowDetail | null> {
  const d = await run<{ workflows_by_pk: WorkflowDetail | null }>(
    `query Workflow($id: uuid!) {
       workflows_by_pk(id: $id) {
         id org_id name description
         steps(order_by: { position: asc }) { id position type config }
         triggers(order_by: { created_at: asc }) { id type config enabled }
         runs(order_by: { started_at: desc }, limit: 10) {
           id status trigger_type started_at finished_at
         }
       }
     }`,
    { id }
  );
  return d.workflows_by_pk;
}

export async function createWorkflow(orgId: string, name: string): Promise<string> {
  const d = await run<{ insert_workflows_one: { id: string } }>(
    `mutation ($orgId: uuid!, $name: String!) {
       insert_workflows_one(object: { org_id: $orgId, name: $name }) { id }
     }`,
    { orgId, name }
  );
  return d.insert_workflows_one.id;
}

export async function updateWorkflowMeta(id: string, name: string, description: string) {
  await run(
    `mutation ($id: uuid!, $name: String!, $description: String) {
       update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: $name, description: $description }) { id }
     }`,
    { id, name, description }
  );
}

// (b) — replace a workflow's steps (delete + insert). The DB permission checks
// still apply per row, so an editor saving a db_write step is rejected here.
export async function saveSteps(workflowId: string, steps: Step[]) {
  await run(
    `mutation ($wf: uuid!, $objs: [workflow_steps_insert_input!]!) {
       delete_workflow_steps(where: { workflow_id: { _eq: $wf } }) { affected_rows }
       insert_workflow_steps(objects: $objs) { affected_rows }
     }`,
    {
      wf: workflowId,
      objs: steps.map((s, i) => ({
        workflow_id: workflowId,
        position: i,
        type: s.type,
        config: s.config ?? {},
      })),
    }
  );
}

export async function addTrigger(
  workflowId: string,
  type: TriggerType,
  secret?: string
) {
  await run(
    `mutation ($wf: uuid!, $type: String!, $secret: String) {
       insert_workflow_triggers_one(object: { workflow_id: $wf, type: $type, secret: $secret, enabled: true }) { id }
     }`,
    { wf: workflowId, type, secret: secret ?? null }
  );
}

export async function removeTrigger(id: string) {
  await run(
    `mutation ($id: uuid!) { delete_workflow_triggers_by_pk(id: $id) { id } }`,
    { id }
  );
}

export async function deleteWorkflow(id: string) {
  await run(`mutation ($id: uuid!) { delete_workflows_by_pk(id: $id) { id } }`, { id });
}

// (c) — trigger a run (Hasura Action; handler enforces role + quota).
export async function triggerWorkflowRun(workflowId: string) {
  return run<{ triggerWorkflowRun: { run_id: string; status: string } }>(
    `mutation ($wf: String!) { triggerWorkflowRun(workflow_id: $wf) { run_id status } }`,
    { wf: workflowId }
  );
}

// (c) — approve a paused approval_gate (Action; handler re-checks role).
export async function approveStep(stepRunId: string) {
  return run<{ approveStep: { run_id: string; status: string } }>(
    `mutation ($id: String!) { approveStep(step_run_id: $id) { run_id status } }`,
    { id: stepRunId }
  );
}

// (d) — live per-step progress for a run (subscription string, used by useSubscription).
export const STEP_RUNS_SUBSCRIPTION = `
  subscription StepRuns($runId: uuid!) {
    step_runs(where: { run_id: { _eq: $runId } }, order_by: { position: asc }) {
      id position step_type status attempt error output approved_by approved_at started_at finished_at
    }
  }
`;

// Live run header (status) — a small subscription so "paused/succeeded" updates live too.
export const RUN_SUBSCRIPTION = `
  subscription Run($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) { id status trigger_type started_at finished_at }
  }
`;
