// Hasura Action handler: approveStep(step_run_id) -> { run_id, status }.
//
// Layer 2, the mid-execution half: clearing an approval_gate is NOT a row
// permission — it's a decision re-checked IN handler code. This handler:
//   1. loads the gate's step_run -> run -> org (admin)
//   2. confirms it is actually awaiting approval
//   3. RE-CHECKS the caller is owner/editor in that org (forwarded session vars)
//   4. records approved_by/approved_at and clears the gate
//   5. resumes the run via runFrom(run, gatePosition + 1)
import type { Request, Response } from "express";
import { adminGql } from "./_lib/hasura";
import { callerId, getMembership, HttpError } from "./_lib/authz";
import { runFrom } from "./_lib/engine";

export default async (req: Request, res: Response) => {
  try {
    const stepRunId: string = req.body?.input?.step_run_id;
    const sessionVariables: Record<string, string> = req.body?.session_variables;
    if (!stepRunId) throw new HttpError(400, "step_run_id is required");

    const userId = callerId(sessionVariables);

    const data = await adminGql<{
      step_runs_by_pk: {
        id: string;
        position: number;
        status: string;
        run: { id: string; status: string; org_id: string };
      } | null;
    }>(
      `query ($id: uuid!) {
         step_runs_by_pk(id: $id) {
           id position status
           run { id status org_id }
         }
       }`,
      { id: stepRunId }
    );
    const sr = data.step_runs_by_pk;
    if (!sr) throw new HttpError(404, "Step run not found");
    if (sr.status !== "awaiting_approval") {
      throw new HttpError(409, "This step is not awaiting approval");
    }

    // The role re-check that cannot be a DB permission: it happens now, mid-run.
    const membership = await getMembership(userId, sr.run.org_id);
    if (!membership || !["owner", "editor"].includes(membership.role)) {
      throw new HttpError(403, "Only an owner or editor can approve this step");
    }

    // Clear the gate: record who approved and when, and mark it succeeded.
    await adminGql(
      `mutation ($id: uuid!, $by: uuid!, $at: timestamptz!) {
         update_step_runs_by_pk(
           pk_columns: { id: $id }
           _set: { status: "succeeded", approved_by: $by, approved_at: $at }
         ) { id }
       }`,
      { id: stepRunId, by: userId, at: new Date().toISOString() }
    );

    // Resume the same resumable executor, starting AFTER the gate.
    const { status } = await runFrom(sr.run.id, sr.position + 1);
    res.status(200).json({ run_id: sr.run.id, status });
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    res.status(status).json({ message: err?.message ?? "Internal error" });
  }
};
