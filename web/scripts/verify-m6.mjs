// M6 verification: db_write persists a real row; notify inserts a row whose
// INSERT fires the Hasura Event Trigger that delivers it.
import { createClient } from "@nhost/nhost-js";

const NHOST = { subdomain: "local", region: "local" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const orgA = (await gql(ownerA, `{ org_members { org_id role } }`)).org_members.find((m) => m.role === "owner").org_id;

// Owner builds a workflow with the owner-only step types.
const wf = (await gql(ownerA, `mutation ($o: uuid!){ insert_workflows_one(object:{org_id:$o,name:"Outputs demo"}){ id } }`, { o: orgA })).insert_workflows_one.id;
await gql(
  ownerA,
  `mutation ($objs: [workflow_steps_insert_input!]!){ insert_workflow_steps(objects:$objs){ affected_rows } }`,
  {
    objs: [
      { workflow_id: wf, position: 0, type: "llm_call", config: { prompt: "Reply with the single word READY." } },
      { workflow_id: wf, position: 1, type: "db_write", config: {} }, // saves prev output
      { workflow_id: wf, position: 2, type: "notify", config: { channel: "slack", message: "Run finished: {{steps.0.text}}" } },
    ],
  }
);

console.log("1) Run the workflow (owner)");
const res = await gql(ownerA, `mutation ($w: String!){ triggerWorkflowRun(workflow_id:$w){ run_id status } }`, { w: wf });
const runId = res.triggerWorkflowRun.run_id;
check("run succeeded", res.triggerWorkflowRun.status === "succeeded");

const srs = (await gql(ownerA, `query ($r: uuid!){ step_runs(where:{run_id:{_eq:$r}}, order_by:{position:asc}){ step_type status output } }`, { r: runId })).step_runs;
check("db_write step succeeded", srs[1].status === "succeeded" && srs[1].output?.saved === true);
check("notify step succeeded", srs[2].status === "succeeded" && !!srs[2].output?.notification_id);

console.log("\n2) db_write persisted a real workflow_outputs row");
const outs = (await gql(ownerA, `query ($r: uuid!){ workflow_outputs(where:{run_id:{_eq:$r}}){ id data } }`, { r: runId })).workflow_outputs;
check("exactly one workflow_outputs row for the run", outs.length === 1);

console.log("\n3) notify → Event Trigger delivered the notification");
let notif = null;
for (let t = 0; t < 20; t++) {
  const rows = (await gql(ownerA, `query ($r: uuid!){ notifications(where:{run_id:{_eq:$r}}){ id status channel message } }`, { r: runId })).notifications;
  notif = rows[0];
  if (notif?.status === "delivered") break;
  await sleep(300);
}
check("notification row created", !!notif);
check("notification channel/message stored", notif?.channel === "slack" && /Run finished/.test(notif?.message ?? ""));
check("Event Trigger marked it delivered", notif?.status === "delivered");

await gql(ownerA, `mutation ($o: uuid!){ delete_workflows(where:{org_id:{_eq:$o}, name:{_eq:"Outputs demo"}}){ affected_rows } }`, { o: orgA });

console.log(failures === 0 ? "\n✅ M6 (db_write + notify) CHECKS PASS" : `\n❌ M6 FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
