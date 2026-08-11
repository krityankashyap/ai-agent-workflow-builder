// M3 verification: the approval gate.
//
//   node scripts/verify-m3.mjs
//
// A run pauses at an approval_gate; only an owner/editor in that org can approve
// (re-checked in the approveStep handler); approval resumes the run live and
// quota increments once, at final completion.
import { createClient } from "@nhost/nhost-js";

const NHOST = { subdomain: "local", region: "local" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (desc, cond) => {
  console.log(`${cond ? "  ✅" : "  ❌"} ${desc}`);
  if (!cond) failures++;
};

async function asUser(email) {
  const c = createClient(NHOST);
  await c.auth.signInEmailPassword({ email, password: "password123" });
  return c;
}
async function gql(client, query, variables) {
  const r = await client.graphql.request({ query, variables });
  if (r.body.errors?.length)
    throw new Error(r.body.errors.map((e) => e.message).join("; "));
  return r.body.data;
}
async function action(client, mutation, variables) {
  try {
    const d = await gql(client, mutation, variables);
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const TRIGGER = `mutation ($wf: String!) { triggerWorkflowRun(workflow_id: $wf) { run_id status } }`;
const APPROVE = `mutation ($id: String!) { approveStep(step_run_id: $id) { run_id status } }`;
const RUN_Q = `query ($wf: uuid!) {
  workflow_runs(where: { workflow_id: { _eq: $wf } }, order_by: { started_at: desc }, limit: 1) {
    id status
    step_runs(order_by: { position: asc }) { id position step_type status approved_by approved_at }
  }
}`;

const ownerA = await asUser("owner-a@example.com");
const editorA = await asUser("editor-a@example.com");
const viewerA = await asUser("viewer-a@example.com");
const ownerB = await asUser("owner-b@example.com");
const editorAId = editorA.getUserSession().user.id;
const orgA = (await gql(ownerA, `{ org_members { org_id role } }`)).org_members.find(
  (m) => m.role === "owner"
).org_id;

// Workflow: llm_call -> approval_gate -> http_request
const wf = (
  await gql(
    ownerA,
    `mutation ($o: uuid!) { insert_workflows_one(object: { org_id: $o, name: "Gated deploy" }) { id } }`,
    { o: orgA }
  )
).insert_workflows_one.id;
await gql(
  ownerA,
  `mutation ($objs: [workflow_steps_insert_input!]!) { insert_workflow_steps(objects: $objs) { affected_rows } }`,
  {
    objs: [
      { workflow_id: wf, position: 0, type: "llm_call", config: { prompt: "Reply with the single word OK." } },
      { workflow_id: wf, position: 1, type: "approval_gate", config: {} },
      { workflow_id: wf, position: 2, type: "http_request", config: { url: "https://api.github.com/zen", method: "GET" } },
    ],
  }
);

const quotaBefore = (
  await gql(ownerA, `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_used } }`, { id: orgA })
).organizations_by_pk.quota_used;

console.log("1) Trigger → run pauses at the approval_gate");
const trig = await action(ownerA, TRIGGER, { wf });
check("trigger returns status = paused", trig.ok && trig.data.triggerWorkflowRun.status === "paused");

let run = (await gql(ownerA, RUN_Q, { wf })).workflow_runs[0];
const gate = run.step_runs.find((s) => s.step_type === "approval_gate");
check("run status = paused", run.status === "paused");
check("llm_call step succeeded before the gate", run.step_runs[0].status === "succeeded");
check("approval_gate is awaiting_approval", gate.status === "awaiting_approval");
check("http_request after the gate is still pending", run.step_runs[2].status === "pending");

const quotaPaused = (
  await gql(ownerA, `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_used } }`, { id: orgA })
).organizations_by_pk.quota_used;
check("quota NOT incremented while paused", quotaPaused === quotaBefore);

console.log("\n2) Only an owner/editor in the org can approve");
const vTry = await action(viewerA, APPROVE, { id: gate.id });
check("viewer A cannot approve (403)", !vTry.ok);
const bTry = await action(ownerB, APPROVE, { id: gate.id });
check("owner B (other org) cannot approve", !bTry.ok);
// Still paused after failed attempts.
run = (await gql(ownerA, RUN_Q, { wf })).workflow_runs[0];
check("run still paused after rejected approvals", run.status === "paused");

console.log("\n3) Editor A approves → run resumes live");
const running = action(editorA, APPROVE, { id: gate.id });
const snaps = [];
for (let t = 0; t < 40; t++) {
  const r = (await gql(ownerA, RUN_Q, { wf })).workflow_runs[0];
  const snap = `${r.status} :: ` + r.step_runs.map((s) => `${s.step_type}:${s.status}`).join(" | ");
  if (snaps[snaps.length - 1] !== snap) {
    snaps.push(snap);
    console.log(`   [t+${t}] ${snap}`);
  }
  if (["succeeded", "failed"].includes(r.status)) break;
  await sleep(200);
}
const appr = await running;
check("approveStep returned succeeded", appr.ok && appr.data.approveStep.status === "succeeded");

run = (await gql(ownerA, RUN_Q, { wf })).workflow_runs[0];
const gate2 = run.step_runs.find((s) => s.step_type === "approval_gate");
check("run completed (succeeded)", run.status === "succeeded");
check("gate recorded approved_by = editor A", gate2.approved_by === editorAId);
check("gate recorded approved_at", !!gate2.approved_at);
check("http_request after gate now succeeded", run.step_runs[2].status === "succeeded");
check("observed live resume (>1 snapshot)", snaps.length > 1);

const quotaAfter = (
  await gql(ownerA, `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_used } }`, { id: orgA })
).organizations_by_pk.quota_used;
check("quota incremented by 1 at final completion", quotaAfter === quotaBefore + 1);

console.log("\n4) Re-approving a cleared gate is rejected");
const again = await action(editorA, APPROVE, { id: gate.id });
check("cannot approve an already-cleared gate (409)", !again.ok);

await gql(ownerA, `mutation ($o: uuid!) { delete_workflows(where: { org_id: { _eq: $o } }) { affected_rows } }`, { o: orgA });

console.log(failures === 0 ? "\n✅ M3 ALL CHECKS PASS" : `\n❌ M3 FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
