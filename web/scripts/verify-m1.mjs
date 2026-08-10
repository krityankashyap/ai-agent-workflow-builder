// M1 verification: full schema + BOTH permission layers, proven end-to-end.
//
//   node scripts/verify-m1.mjs
//
// Covers:
//   1. An owner in Org A builds a workflow (steps + trigger).
//   2. Cross-org isolation: an Org B user cannot read that workflow / its steps /
//      triggers / runs even with the exact IDs.
//   3. Layer 1 (org+role): a viewer cannot create a workflow; an editor can.
//   4. Layer 2 (step gating): an editor cannot add a db_write step or a webhook
//      trigger; the owner can.
//   5. The aggregation view is org-scoped.
import { createClient } from "@nhost/nhost-js";

const NHOST = { subdomain: "local", region: "local" };
let failures = 0;

function check(desc, cond) {
  console.log(`${cond ? "  ✅" : "  ❌"} ${desc}`);
  if (!cond) failures++;
}

async function asUser(email) {
  const c = createClient(NHOST);
  await c.auth.signInEmailPassword({ email, password: "password123" });
  return c;
}

// Returns { data } or throws.
async function gql(client, query, variables) {
  const r = await client.graphql.request({ query, variables });
  if (r.body.errors?.length)
    throw new Error(r.body.errors.map((e) => e.message).join("; "));
  return r.body.data;
}

// Returns true if the mutation/query succeeded, false if it was rejected.
async function allowed(client, query, variables) {
  try {
    await gql(client, query, variables);
    return true;
  } catch {
    return false;
  }
}

const ownerA = await asUser("owner-a@example.com");
const editorA = await asUser("editor-a@example.com");
const viewerA = await asUser("viewer-a@example.com");
const ownerB = await asUser("owner-b@example.com");

// Org A id (from the owner's own membership row).
const orgA = (
  await gql(ownerA, `query { org_members { org_id role } }`)
).org_members.find((m) => m.role === "owner").org_id;

console.log("\n1) Owner A builds a workflow in Org A");
const wf = (
  await gql(
    ownerA,
    `mutation ($orgId: uuid!) {
       insert_workflows_one(object: {
         org_id: $orgId, name: "Lead triage", description: "M1 verify"
       }) { id }
     }`,
    { orgId: orgA }
  )
).insert_workflows_one.id;

// Ordered steps: llm_call -> http_request -> conditional_branch -> approval_gate
await gql(
  ownerA,
  `mutation ($wf: uuid!) {
     insert_workflow_steps(objects: [
       { workflow_id: $wf, position: 0, type: "llm_call", config: {} },
       { workflow_id: $wf, position: 1, type: "http_request", config: {} },
       { workflow_id: $wf, position: 2, type: "conditional_branch", config: {} },
       { workflow_id: $wf, position: 3, type: "approval_gate", config: {} }
     ]) { affected_rows }
   }`,
  { wf }
);
const manualTrigger = (
  await gql(
    ownerA,
    `mutation ($wf: uuid!) {
       insert_workflow_triggers_one(object: { workflow_id: $wf, type: "manual" }) { id }
     }`,
    { wf }
  )
).insert_workflow_triggers_one.id;
const readBack = await gql(
  ownerA,
  `query ($wf: uuid!) {
     workflows_by_pk(id: $wf) { id name steps { position type } triggers { type } }
   }`,
  { wf }
);
check("owner A reads back workflow with 4 steps + 1 trigger",
  readBack.workflows_by_pk?.steps.length === 4 &&
  readBack.workflows_by_pk?.triggers.length === 1);
console.log(`   workflow id: ${wf}`);

console.log("\n2) Cross-org isolation — Org B user, exact IDs");
const bSeesWf = await gql(
  ownerB,
  `query ($wf: uuid!) { workflows_by_pk(id: $wf) { id } }`,
  { wf }
);
check("owner B cannot read Org A workflow by id", bSeesWf.workflows_by_pk === null);

const bSeesSteps = await gql(
  ownerB,
  `query ($wf: uuid!) { workflow_steps(where: { workflow_id: { _eq: $wf } }) { id } }`,
  { wf }
);
check("owner B sees zero steps of Org A workflow", bSeesSteps.workflow_steps.length === 0);

const bSeesTrigger = await gql(
  ownerB,
  `query ($id: uuid!) { workflow_triggers(where: { id: { _eq: $id } }) { id } }`,
  { id: manualTrigger }
);
check("owner B sees zero triggers of Org A workflow", bSeesTrigger.workflow_triggers.length === 0);

check("owner B cannot inject a step into Org A workflow (write isolation)",
  !(await allowed(
    ownerB,
    `mutation ($wf: uuid!) {
       insert_workflow_steps_one(object: { workflow_id: $wf, position: 9, type: "llm_call" }) { id }
     }`,
    { wf }
  )));

console.log("\n3) Layer 1 — org + role scoping");
check("viewer A CANNOT create a workflow",
  !(await allowed(
    viewerA,
    `mutation ($orgId: uuid!) { insert_workflows_one(object: { org_id: $orgId, name: "nope" }) { id } }`,
    { orgId: orgA }
  )));
check("editor A CAN create a workflow",
  await allowed(
    editorA,
    `mutation ($orgId: uuid!) { insert_workflows_one(object: { org_id: $orgId, name: "editor wf" }) { id } }`,
    { orgId: orgA }
  ));

console.log("\n4) Layer 2 — step-level owner-only gating");
check("editor A CANNOT add a db_write step",
  !(await allowed(editorA,
    `mutation ($wf: uuid!) { insert_workflow_steps_one(object: { workflow_id: $wf, position: 5, type: "db_write" }) { id } }`,
    { wf })));
check("editor A CANNOT add a webhook trigger",
  !(await allowed(editorA,
    `mutation ($wf: uuid!) { insert_workflow_triggers_one(object: { workflow_id: $wf, type: "webhook", secret: "s" }) { id } }`,
    { wf })));
check("editor A CAN add a normal llm_call step",
  await allowed(editorA,
    `mutation ($wf: uuid!) { insert_workflow_steps_one(object: { workflow_id: $wf, position: 6, type: "llm_call" }) { id } }`,
    { wf }));
check("owner A CAN add a db_write step",
  await allowed(ownerA,
    `mutation ($wf: uuid!) { insert_workflow_steps_one(object: { workflow_id: $wf, position: 7, type: "db_write" }) { id } }`,
    { wf }));
check("owner A CAN add a webhook trigger",
  await allowed(ownerA,
    `mutation ($wf: uuid!) { insert_workflow_triggers_one(object: { workflow_id: $wf, type: "webhook", secret: "s" }) { id } }`,
    { wf }));

console.log("\n5) Aggregation view is org-scoped");
const aStats = await gql(ownerA,
  `query ($wf: uuid!) { workflow_run_stats(where: { workflow_id: { _eq: $wf } }) { total_runs avg_duration_seconds } }`,
  { wf });
check("owner A sees stats row for the workflow", aStats.workflow_run_stats.length === 1);
const bStats = await gql(ownerB,
  `query ($wf: uuid!) { workflow_run_stats(where: { workflow_id: { _eq: $wf } }) { total_runs } }`,
  { wf });
check("owner B sees no stats for Org A workflow", bStats.workflow_run_stats.length === 0);

// Cleanup: remove the workflows created by this run (owner can delete).
await gql(ownerA,
  `mutation ($orgId: uuid!) { delete_workflows(where: { org_id: { _eq: $orgId } }) { affected_rows } }`,
  { orgId: orgA });

console.log(
  failures === 0
    ? "\n✅ M1 ALL CHECKS PASS"
    : `\n❌ M1 FAILED (${failures} check(s))`
);
process.exit(failures === 0 ? 0 : 1);
