// M5 verification (data layer): runs the exact GraphQL queries the UI uses, to
// catch field typos (strings aren't typechecked) and confirm the in-UI isolation
// path — getWorkflow returns null for a non-member, which renders "not found".
import { createClient } from "@nhost/nhost-js";

const NHOST = { subdomain: "local", region: "local" };
let failures = 0;
const check = (d, c) => {
  console.log(`${c ? "  ✅" : "  ❌"} ${d}`);
  if (!c) failures++;
};
async function asUser(email) {
  const c = createClient(NHOST);
  await c.auth.signInEmailPassword({ email, password: "password123" });
  return c;
}
async function gql(c, q, v) {
  const r = await c.graphql.request({ query: q, variables: v });
  if (r.body.errors?.length) throw new Error(r.body.errors.map((e) => e.message).join("; "));
  return r.body.data;
}

const ownerA = await asUser("owner-a@example.com");
const ownerB = await asUser("owner-b@example.com");
const orgA = (await gql(ownerA, `{ org_members { org_id role } }`)).org_members.find(
  (m) => m.role === "owner"
).org_id;

const wf = (
  await gql(ownerA, `mutation ($o: uuid!){ insert_workflows_one(object:{org_id:$o,name:"M5 UI check"}){ id } }`, { o: orgA })
).insert_workflows_one.id;
await gql(ownerA, `mutation ($w: uuid!){ insert_workflow_steps_one(object:{workflow_id:$w,position:0,type:"llm_call",config:{}}){ id } }`, { w: wf });
await gql(ownerA, `mutation ($w: uuid!){ insert_workflow_triggers_one(object:{workflow_id:$w,type:"manual"}){ id } }`, { w: wf });

// getWorkflows (list page query)
const list = await gql(
  ownerA,
  `query OrgWorkflows($orgId: uuid!) {
     workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
       id name description
       steps { id }
       triggers { id type }
       runs(order_by: { started_at: desc }, limit: 1) { id status started_at }
     }
   }`,
  { orgId: orgA }
);
const row = list.workflows.find((w) => w.id === wf);
check("list query returns workflow with steps/triggers/runs", !!row && row.steps.length === 1 && row.triggers.length === 1);

// getWorkflow (detail page query)
const detail = await gql(
  ownerA,
  `query Workflow($id: uuid!) {
     workflows_by_pk(id: $id) {
       id org_id name description
       steps(order_by: { position: asc }) { id position type config }
       triggers(order_by: { created_at: asc }) { id type config enabled }
       runs(order_by: { started_at: desc }, limit: 10) { id status trigger_type started_at finished_at }
     }
   }`,
  { id: wf }
);
check("detail query returns steps + triggers", detail.workflows_by_pk?.steps.length === 1 && detail.workflows_by_pk?.triggers.length === 1);

// Isolation in the UI: owner B's detail query returns null -> "Workflow not found".
const bDetail = await gql(
  ownerB,
  `query ($id: uuid!) { workflows_by_pk(id: $id) { id } }`,
  { id: wf }
);
check("owner B detail query returns null (renders not-found)", bDetail.workflows_by_pk === null);

await gql(ownerA, `mutation ($id: uuid!){ delete_workflows_by_pk(id:$id){ id } }`, { id: wf });

console.log(failures === 0 ? "\n✅ M5 UI DATA CHECKS PASS" : `\n❌ M5 FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
