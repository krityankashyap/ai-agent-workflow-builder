// M6c verification: database_event trigger (row INSERT auto-starts a run via a
// Hasura Event Trigger) and scheduled trigger (Cron -> onSchedule starts runs).
import { createClient } from "@nhost/nhost-js";

const NHOST = { subdomain: "local", region: "local" };
const SCHEDULE_URL = "https://local.functions.local.nhost.run/v1/onSchedule";
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
async function makeWorkflow(c, orgId, name, triggerType) {
  const wf = (await gql(c, `mutation ($o: uuid!, $n: String!){ insert_workflows_one(object:{org_id:$o,name:$n}){ id } }`, { o: orgId, n: name })).insert_workflows_one.id;
  await gql(c, `mutation ($w: uuid!){ insert_workflow_steps_one(object:{workflow_id:$w,position:0,type:"http_request",config:{url:"https://api.github.com/zen",method:"GET"}}){ id } }`, { w: wf });
  await gql(c, `mutation ($w: uuid!, $t: String!){ insert_workflow_triggers_one(object:{workflow_id:$w,type:$t,enabled:true}){ id } }`, { w: wf, t: triggerType });
  return wf;
}
const RUNS = `query ($w: uuid!){ workflow_runs(where:{workflow_id:{_eq:$w}}, order_by:{started_at:desc}){ id status trigger_type } }`;

const ownerA = await asUser("owner-a@example.com");
const orgA = (await gql(ownerA, `{ org_members { org_id role } }`)).org_members.find((m) => m.role === "owner").org_id;

console.log("1) database_event: an INSERT into a watched table auto-starts a run");
const wfDb = await makeWorkflow(ownerA, orgA, "DB event demo", "database_event");
await gql(ownerA, `mutation ($o: uuid!){ insert_incoming_events_one(object:{org_id:$o, payload:{source:"verify"}}){ id } }`, { o: orgA });
let dbRun = null;
for (let t = 0; t < 25; t++) {
  const runs = (await gql(ownerA, RUNS, { w: wfDb })).workflow_runs;
  dbRun = runs.find((r) => r.trigger_type === "database_event");
  if (dbRun && dbRun.status === "succeeded") break;
  await sleep(300);
}
check("a run started from the DB event", !!dbRun);
check("run.trigger_type = database_event and it completed", dbRun?.trigger_type === "database_event" && dbRun?.status === "succeeded");

console.log("\n2) scheduled: the cron endpoint starts runs for scheduled triggers");
const wfCron = await makeWorkflow(ownerA, orgA, "Cron demo", "scheduled");
// Simulate the cron firing (Hasura Cron Trigger POSTs here on schedule).
const r = await fetch(SCHEDULE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("onSchedule endpoint responded 200", r.status === 200);
let cronRun = null;
for (let t = 0; t < 25; t++) {
  const runs = (await gql(ownerA, RUNS, { w: wfCron })).workflow_runs;
  cronRun = runs.find((x) => x.trigger_type === "scheduled");
  if (cronRun && cronRun.status === "succeeded") break;
  await sleep(300);
}
check("a run started from the schedule", !!cronRun);
check("run.trigger_type = scheduled and it completed", cronRun?.trigger_type === "scheduled" && cronRun?.status === "succeeded");

// Cleanup — delete the demo workflows so the every-minute cron stops firing them.
// (incoming_events rows are harmless leftovers: the Event Trigger only fires on
// INSERT, and users have no delete permission on that table.)
await gql(ownerA, `mutation ($o: uuid!){ delete_workflows(where:{org_id:{_eq:$o}, name:{_in:["DB event demo","Cron demo"]}}){ affected_rows } }`, { o: orgA });

console.log(failures === 0 ? "\n✅ M6c (scheduled + database_event) CHECKS PASS" : `\n❌ M6c FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
