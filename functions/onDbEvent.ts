// database_event trigger. Hasura Event Trigger handler: fires on INSERT into
// public.incoming_events and starts a run for every workflow in that event's org
// that has an enabled `database_event` trigger — a row change auto-starts a run.
import type { Request, Response } from "express";
import { adminGql } from "./_lib/hasura";
import { createRun, runFrom } from "./_lib/engine";

export default async (req: Request, res: Response) => {
  try {
    const row = req.body?.event?.data?.new;
    if (!row?.org_id) return res.status(200).json({ skipped: true });

    const data = await adminGql<{ workflow_triggers: { workflow_id: string }[] }>(
      `query ($org: uuid!) {
         workflow_triggers(
           where: {
             type: { _eq: "database_event" }
             enabled: { _eq: true }
             workflow: { org_id: { _eq: $org } }
           }
         ) { workflow_id }
       }`,
      { org: row.org_id }
    );

    for (const t of data.workflow_triggers) {
      const runId = await createRun(t.workflow_id, row.org_id, {
        triggeredBy: null,
        triggerType: "database_event",
      });
      await runFrom(runId, 0);
    }
    res.status(200).json({ started: data.workflow_triggers.length });
  } catch (err: any) {
    res.status(500).json({ message: err?.message ?? "onDbEvent failed" });
  }
};
