// Inbound WEBHOOK trigger — a public endpoint external systems POST to in order
// to start a run with no button click. There is no JWT here: the trigger's
// stored `secret` is the credential. (Only an owner can create a webhook trigger
// — Layer 2 — so issuing these secrets is itself gated.)
//
//   POST https://<functions>/v1/webhook
//   { "trigger_id": "<uuid>", "secret": "<secret>" }
//
// On success it creates a run (trigger_type = "webhook") and executes it via the
// same runFrom engine, so it streams live exactly like a manual run.
import type { Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { adminGql } from "./_lib/hasura";
import { createRun, runFrom } from "./_lib/engine";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const first = (v: unknown): string =>
  Array.isArray(v) ? String(v[0] ?? "") : v == null ? "" : String(v);

export default async (req: Request, res: Response) => {
  try {
    const triggerId = first(req.body?.trigger_id ?? req.query?.trigger_id);
    const secret = first(req.body?.secret ?? req.headers["x-webhook-secret"]);
    if (!triggerId || !secret) {
      return res.status(400).json({ message: "trigger_id and secret are required" });
    }

    const data = await adminGql<{
      workflow_triggers_by_pk: {
        type: string;
        enabled: boolean;
        secret: string | null;
        workflow_id: string;
        workflow: { org_id: string };
      } | null;
    }>(
      `query ($id: uuid!) {
         workflow_triggers_by_pk(id: $id) {
           type enabled secret workflow_id
           workflow { org_id }
         }
       }`,
      { id: triggerId }
    );
    const trg = data.workflow_triggers_by_pk;

    // Uniform 401 whether the trigger is missing, the wrong type, disabled, or the
    // secret is wrong — don't reveal which check failed.
    if (
      !trg ||
      trg.type !== "webhook" ||
      !trg.enabled ||
      !trg.secret ||
      !safeEqual(secret, trg.secret)
    ) {
      return res.status(401).json({ message: "Invalid webhook credentials" });
    }

    // Quota check before running.
    const orgId = trg.workflow.org_id;
    const orgData = await adminGql<{
      organizations_by_pk: { quota_used: number; quota_limit: number } | null;
    }>(
      `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_used quota_limit } }`,
      { id: orgId }
    );
    const q = orgData.organizations_by_pk;
    if (q && q.quota_used >= q.quota_limit) {
      return res.status(429).json({ message: "Organization quota exhausted" });
    }

    // No triggering user for a webhook — triggered_by stays null.
    const runId = await createRun(trg.workflow_id, orgId, {
      triggeredBy: null,
      triggerType: "webhook",
    });
    const { status } = await runFrom(runId, 0);
    res.status(200).json({ run_id: runId, status });
  } catch (err: any) {
    res.status(500).json({ message: err?.message ?? "Internal error" });
  }
};
