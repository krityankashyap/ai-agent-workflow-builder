// M4 verification: a webhook trigger starts a run with no button click.
//
//   node scripts/verify-m4.mjs
//
// An owner creates a workflow + webhook trigger (with a secret). An EXTERNAL
// caller (plain fetch, no login) POSTs to the public webhook URL; the run starts,
// streams live, and completes. A wrong secret is rejected and starts nothing.
import { createClient } from "@nhost/nhost-js";

const NHOST = { subdomain: "local", region: "local" };
const WEBHOOK_URL = "https://local.functions.local.nhost.run/v1/webhook";
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
  if (r.body.errors?.length) throw new Error(r.body.errors.map((e) => e.message).join("; "));
  return r.body.data;
}
// Simulate an external system with a bare fetch — no auth header at all.
async function postWebhook(body) {
  const r = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}

const ownerA = await asUser("owner-a@example.com");
const orgA = (await gql(ownerA, `{ org_members { org_id role } }`)).org_members.find(
  (m) => m.role === "owner"
).org_id;

// Owner builds a workflow + a webhook trigger with a known secret.
const SECRET = "whsec_" + Math.random().toString(36).slice(2);
const wf = (
  await gql(ownerA, `mutation ($o: uuid!) { insert_workflows_one(object: { org_id: $o, name: "Webhook run" }) { id } }`, { o: orgA })
).insert_workflows_one.id;
await gql(
  ownerA,
  `mutation ($objs: [workflow_steps_insert_input!]!) { insert_workflow_steps(objects: $objs) { affected_rows } }`,
  {
    objs: [
      { workflow_id: wf, position: 0, type: "llm_call", config: { prompt: "Reply with the single word DONE." } },
      { workflow_id: wf, position: 1, type: "http_request", config: { url: "https://api.github.com/zen", method: "GET" } },
    ],
  }
);
const trigger = (
  await gql(
    ownerA,
    `mutation ($wf: uuid!, $s: String!) {
       insert_workflow_triggers_one(object: { workflow_id: $wf, type: "webhook", secret: $s, enabled: true }) { id }
     }`,
    { wf, s: SECRET }
  )
).insert_workflow_triggers_one.id;
console.log("workflow:", wf, "\nwebhook trigger:", trigger);

const RUNS = `query ($wf: uuid!) {
  workflow_runs(where: { workflow_id: { _eq: $wf } }, order_by: { started_at: desc }) {
    id status trigger_type triggered_by
    step_runs(order_by: { position: asc }) { step_type status }
  }
}`;
const quotaBefore = (await gql(ownerA, `query ($id: uuid!){ organizations_by_pk(id:$id){ quota_used } }`, { id: orgA }))
  .organizations_by_pk.quota_used;

console.log("\n1) Wrong secret is rejected and starts nothing");
const bad = await postWebhook({ trigger_id: trigger, secret: "wrong" });
check("wrong secret → HTTP 401", bad.status === 401);
const runsAfterBad = (await gql(ownerA, RUNS, { wf })).workflow_runs;
check("no run created by the rejected call", runsAfterBad.length === 0);

console.log("\n2) Valid secret starts a run with no button click (streams live)");
const firing = postWebhook({ trigger_id: trigger, secret: SECRET });
const snaps = [];
for (let t = 0; t < 60; t++) {
  const runs = (await gql(ownerA, RUNS, { wf })).workflow_runs;
  const run = runs[0];
  if (run) {
    const snap = `${run.status} :: ` + run.step_runs.map((s) => `${s.step_type}:${s.status}`).join(" | ");
    if (snaps[snaps.length - 1] !== snap) {
      snaps.push(snap);
      console.log(`   [t+${t}] ${snap}`);
    }
    if (["succeeded", "failed"].includes(run.status)) break;
  }
  await sleep(250);
}
const resp = await firing;
check("webhook responded HTTP 200 with run_id", resp.status === 200 && !!resp.json?.run_id);

const run = (await gql(ownerA, RUNS, { wf })).workflow_runs[0];
check("exactly one run was created", (await gql(ownerA, RUNS, { wf })).workflow_runs.length === 1);
check("run.trigger_type = webhook", run.trigger_type === "webhook");
check("run.triggered_by is null (no user, external call)", run.triggered_by === null);
check("run completed (succeeded)", run.status === "succeeded");
check("both steps succeeded", run.step_runs.every((s) => s.status === "succeeded"));
check("observed live progression (>1 snapshot)", snaps.length > 1);

const quotaAfter = (await gql(ownerA, `query ($id: uuid!){ organizations_by_pk(id:$id){ quota_used } }`, { id: orgA }))
  .organizations_by_pk.quota_used;
check("quota incremented by 1", quotaAfter === quotaBefore + 1);

await gql(ownerA, `mutation ($o: uuid!) { delete_workflows(where: { org_id: { _eq: $o } }) { affected_rows } }`, { o: orgA });

console.log(failures === 0 ? "\n✅ M4 ALL CHECKS PASS" : `\n❌ M4 FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
