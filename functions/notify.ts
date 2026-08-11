// Hasura EVENT TRIGGER handler for the `notify` step. It fires on every INSERT
// into public.notifications (see the event_triggers block in the table metadata).
//
// In a real system this would call Slack/email; here we log the message and flip
// the row to `delivered` so the effect is observable in the UI and in tests.
import type { Request, Response } from "express";
import { adminGql } from "./_lib/hasura";

export default async (req: Request, res: Response) => {
  try {
    const row = req.body?.event?.data?.new;
    if (!row?.id) return res.status(200).json({ skipped: true });

    console.log(
      `[notify] #${row.id} org=${row.org_id} channel=${row.channel} :: ${row.message}`
    );

    await adminGql(
      `mutation ($id: uuid!, $at: timestamptz!) {
         update_notifications_by_pk(
           pk_columns: { id: $id }
           _set: { status: "delivered", delivered_at: $at }
         ) { id }
       }`,
      { id: row.id, at: new Date().toISOString() }
    );

    res.status(200).json({ delivered: true });
  } catch (err: any) {
    res.status(500).json({ message: err?.message ?? "notify failed" });
  }
};
