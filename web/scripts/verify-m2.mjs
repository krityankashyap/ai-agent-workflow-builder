// M2 verification: the execution engine end-to-end.
//
//   node scripts/verify-m2.mjs
//
// Covers: a manual run of llm_call (real Groq) -> conditional_branch (on the LLM
// output) -> http_request; live per-step progression observed by a concurrent
// reader (what the subscription sees); quota increment; handler authz; and the
// retry path recording attempt + error.
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
async function callTrigger(client, wf) {
  // Returns { ok, data, error } — the action returns non-2xx (throws) on authz/quota failure.
  try {
    const d = await gql(
      client,
      `mutation ($wf: String!) { triggerWorkflowRun(workflow_id: $wf) { run_id status } }`,
      { wf }
    );
    return { ok: true, ...d.triggerWorkflowRun };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const ownerA = await asUser("owner-a@example.com");
const viewerA = await asUser("viewer-a@example.com");
const ownerB = await asUser("owner-b@example.com");
const orgA = (await gql(ownerA, `{ org_members { org_id role } }`)).org_members.find(
  (m) => m.role === "owner"
).org_id;

// --- Build the demo workflow (owner A) -------------------------------------
async function buildWorkflow(name, steps) {
  const wf = (
    await gql(
      ownerA,
      `mutation ($orgId: uuid!, $name: String!) {
         insert_workflows_one(object: { org_id: $orgId, name: $name }) { id }
       }`,
      { orgId: orgA, name }
    )
  ).insert_workflows_one.id;
  await gql(
    ownerA,
    `mutation ($objs: [workflow_steps_insert_input!]!) {
       insert_workflow_steps(objects: $objs) { affected_rows }
     }`,
    { objs: steps.map((s, i) => ({ workflow_id: wf, position: i, ...s })) }
  );
  await gql(
    ownerA,
    `mutation ($wf: uuid!) { insert_workflow_triggers_one(object: { workflow_id: $wf, type: "manual" }) { id } }`,
    { wf }
  );
  return wf;
}

console.log("1) Manual run: llm_call -> conditional_branch -> http_request");
const wf = await buildWorkflow("Support triage", [
  {
    type: "llm_call",
    config: {
      system: "You are a ticket classifier. Reply with exactly one word: URGENT or NORMAL.",
      prompt:
        "Ticket: 'Production is down and customers cannot checkout right now.' Classify it.",
    },
  },
  {
    // Branch on the LLM output: only escalate (run the http_request) if URGENT.
    type: "conditional_branch",
    config: { left: "{{prev.text}}", operator: "contains", right: "URGENT", if_false: "skip_next" },
  },
  {
    type: "http_request",
    config: { url: "https://api.github.com/zen", method: "GET" },
  },
]);

// Quota before.
const quotaBefore = (
  await gql(ownerA, `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_used } }`, { id: orgA })
).organizations_by_pk.quota_used;

// Fire the trigger WITHOUT awaiting, and concurrently observe step_runs — this
// is exactly what the GraphQL subscription streams to the UI.
const running = callTrigger(ownerA, wf);
const snapshots = [];
for (let t = 0; t < 60; t++) {
  const runs = (
    await gql(
      ownerA,
      `query ($wf: uuid!) {
         workflow_runs(where: { workflow_id: { _eq: $wf } }, order_by: { started_at: desc }, limit: 1) {
           id status
           step_runs(order_by: { position: asc }) { position step_type status attempt }
         }
       }`,
      { wf }
    )
  ).workflow_runs;
  const run = runs[0];
  if (run) {
    const snap = run.step_runs.map((s) => `${s.step_type}:${s.status}`).join(" | ");
    if (snapshots[snapshots.length - 1] !== snap) {
      snapshots.push(snap);
      console.log(`   [t+${t}] ${run.status.padEnd(9)} ${snap}`);
    }
    if (["succeeded", "failed", "paused"].includes(run.status)) break;
  }
  await sleep(250);
}
const result = await running;

const finalRun = (
  await gql(
    ownerA,
    `query ($wf: uuid!) {
       workflow_runs(where: { workflow_id: { _eq: $wf } }, order_by: { started_at: desc }, limit: 1) {
         status
         step_runs(order_by: { position: asc }) { step_type status output attempt }
       }
     }`,
    { wf }
  )
).workflow_runs[0];
const sr = finalRun.step_runs;

check("trigger returned run_id + succeeded", result.ok && result.status === "succeeded");
check("observed >1 distinct live snapshots (progression)", snapshots.length > 1);
check("llm_call succeeded with text output", sr[0].status === "succeeded" && !!sr[0].output?.text);
check("conditional_branch evaluated condition = true (URGENT)", sr[1].output?.condition === true);
check("http_request ran (not skipped) and succeeded", sr[2].status === "succeeded" && sr[2].output?.status === 200);
console.log(`   LLM said: "${(sr[0].output?.text || "").trim().slice(0, 40)}"`);

const quotaAfter = (
  await gql(ownerA, `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_used } }`, { id: orgA })
).organizations_by_pk.quota_used;
check("quota incremented by 1 on completion", quotaAfter === quotaBefore + 1);

console.log("\n2) Handler authz (trust boundary)");
const viewerTry = await callTrigger(viewerA, wf);
check("viewer A cannot trigger (403 from handler)", !viewerTry.ok);
const ownerBTry = await callTrigger(ownerB, wf);
check("owner B cannot trigger Org A workflow", !ownerBTry.ok);

console.log("\n3) Retry path records attempt + error");
const failWf = await buildWorkflow("Retry demo", [
  { type: "http_request", config: { url: "https://example.com", _test_fail: true } },
]);
const failRes = await callTrigger(ownerA, failWf);
const failRun = (
  await gql(
    ownerA,
    `query ($wf: uuid!) {
       workflow_runs(where: { workflow_id: { _eq: $wf } }, order_by: { started_at: desc }, limit: 1) {
         status step_runs { status attempt error }
       }
     }`,
    { wf: failWf }
  )
).workflow_runs[0];
check("failing run reports status failed", failRes.status === "failed" && failRun.status === "failed");
check("failed step recorded attempt = 2 (>=1 retry)", failRun.step_runs[0].attempt === 2);
check("failed step recorded an error", !!failRun.step_runs[0].error);

// Cleanup workflows created here.
await gql(ownerA, `mutation ($orgId: uuid!) { delete_workflows(where: { org_id: { _eq: $orgId } }) { affected_rows } }`, { orgId: orgA });

console.log(failures === 0 ? "\n✅ M2 ALL CHECKS PASS" : `\n❌ M2 FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
