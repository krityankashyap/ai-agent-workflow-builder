// Hasura Action handler: triggerWorkflowRun(workflow_id) -> { run_id, status }.
//
// This runs with admin DB access, so it is the trust boundary and authorizes the
// call itself using Hasura's forwarded session_variables (unforgeable):
//   1. resolve the workflow's org
//   2. require the caller to be owner/editor IN THAT ORG (never trust input)
//   3. check the org's quota
//   4. create the run + pending step_runs, then execute via runFrom(run, 0)
import type { Request, Response } from "express";
import { adminGql } from "./_lib/hasura";
import { callerId, getMembership, getWorkflowOrg, HttpError } from "./_lib/authz";
import { createRun, runFrom } from "./_lib/engine";

export default async (req: Request, res: Response) => {
  try {
    const workflowId: string = req.body?.input?.workflow_id;
    const sessionVariables: Record<string, string> = req.body?.session_variables;
    if (!workflowId) throw new HttpError(400, "workflow_id is required");

    const userId = callerId(sessionVariables);

    // 1 + 2: authorize against the workflow's own org.
    const orgId = await getWorkflowOrg(workflowId);
    if (!orgId) throw new HttpError(404, "Workflow not found");
    const membership = await getMembership(userId, orgId);
    if (!membership || !["owner", "editor"].includes(membership.role)) {
      throw new HttpError(403, "Only an owner or editor can trigger this workflow");
    }

    // 3: quota check BEFORE running.
    const org = await adminGql<{
      organizations_by_pk: { quota_used: number; quota_limit: number } | null;
    }>(
      `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_used quota_limit } }`,
      { id: orgId }
    );
    const q = org.organizations_by_pk;
    if (q && q.quota_used >= q.quota_limit) {
      throw new HttpError(429, "Organization quota exhausted");
    }

    // 4: create + execute. runFrom persists every transition (live subscription)
    // and increments quota on terminal completion.
    const runId = await createRun(workflowId, orgId, {
      triggeredBy: userId,
      triggerType: "manual",
    });
    const { status } = await runFrom(runId, 0);

    res.status(200).json({ run_id: runId, status });
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    // Hasura surfaces { message } to the client on a non-2xx action response.
    res.status(status).json({ message: err?.message ?? "Internal error" });
  }
};
