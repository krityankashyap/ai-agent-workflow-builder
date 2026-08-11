// scheduled (cron) trigger. Hasura Cron Trigger POSTs here on a schedule (see
// nhost/metadata/cron_triggers.yaml). It starts a run for every workflow with an
// enabled `scheduled` trigger. No-op when there are none.
import type { Request, Response } from "express";
import { adminGql } from "./_lib/hasura";
import { createRun, runFrom } from "./_lib/engine";

export default async (_req: Request, res: Response) => {
  try {
    const data = await adminGql<{
      workflow_triggers: { workflow_id: string; workflow: { org_id: string } }[];
    }>(
      `query {
         workflow_triggers(where: { type: { _eq: "scheduled" }, enabled: { _eq: true } }) {
           workflow_id
           workflow { org_id }
         }
       }`
    );

    for (const t of data.workflow_triggers) {
      const runId = await createRun(t.workflow_id, t.workflow.org_id, {
        triggeredBy: null,
        triggerType: "scheduled",
      });
      await runFrom(runId, 0);
    }
    res.status(200).json({ started: data.workflow_triggers.length });
  } catch (err: any) {
    res.status(500).json({ message: err?.message ?? "onSchedule failed" });
  }
};
