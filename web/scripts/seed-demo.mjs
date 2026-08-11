// Seed a turnkey DEMO workflow in Org A so the live scenario is one click away.
// Idempotent: replaces any existing "Support triage demo" in Org A.
//
//   node scripts/seed-demo.mjs
//
// Runs as owner-a through the normal API (so it exercises the real permissions,
// including the owner-only webhook trigger).
import { createClient } from "@nhost/nhost-js";

const NHOST = {
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN ?? "local",
  region: process.env.NEXT_PUBLIC_NHOST_REGION ?? "local",
};
const nhost = createClient(NHOST);
await nhost.auth.signInEmailPassword({ email: "owner-a@example.com", password: "password123" });

async function gql(query, variables) {
  const r = await nhost.graphql.request({ query, variables });
  if (r.body.errors?.length) throw new Error(r.body.errors.map((e) => e.message).join("; "));
  return r.body.data;
}

const orgA = (await gql(`{ org_members { org_id role organization { name } } }`)).org_members.find(
  (m) => m.role === "owner" && m.organization.name.includes("Org A")
).org_id;

const NAME = "Support triage demo";
await gql(
  `mutation ($o: uuid!, $n: String!) { delete_workflows(where: { org_id: { _eq: $o }, name: { _eq: $n } }) { affected_rows } }`,
  { o: orgA, n: NAME }
);

const wf = (
  await gql(
    `mutation ($o: uuid!, $n: String!) {
       insert_workflows_one(object: { org_id: $o, name: $n, description: "LLM triage → branch → escalate → approval → post" }) { id }
     }`,
    { o: orgA, n: NAME }
  )
).insert_workflows_one.id;

// llm_call → conditional_branch(on LLM output) → http_request → approval_gate → http_request
const steps = [
  {
    type: "llm_call",
    config: {
      system: "You classify support tickets. Reply with exactly one word: URGENT or NORMAL.",
      prompt: "Ticket: 'Production is down and customers cannot check out right now.' Classify it.",
    },
  },
  {
    type: "conditional_branch",
    config: { left: "{{prev.text}}", operator: "contains", right: "URGENT", if_false: "skip_next" },
  },
  {
    type: "http_request",
    config: { url: "https://api.github.com/zen", method: "GET" }, // "escalate" (runs only if URGENT)
  },
  { type: "approval_gate", config: {} },
  {
    type: "http_request",
    config: { url: "https://api.github.com/zen", method: "GET" }, // "post result" after approval
  },
];
await gql(
  `mutation ($objs: [workflow_steps_insert_input!]!) { insert_workflow_steps(objects: $objs) { affected_rows } }`,
  { objs: steps.map((s, i) => ({ workflow_id: wf, position: i, type: s.type, config: s.config })) }
);

// Manual + webhook triggers.
await gql(`mutation ($w: uuid!) { insert_workflow_triggers_one(object: { workflow_id: $w, type: "manual" }) { id } }`, { w: wf });
const secret = "whsec_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const trg = (
  await gql(
    `mutation ($w: uuid!, $s: String!) { insert_workflow_triggers_one(object: { workflow_id: $w, type: "webhook", secret: $s, enabled: true }) { id } }`,
    { w: wf, s: secret }
  )
).insert_workflow_triggers_one.id;

const fnUrl = nhost.graphql.url.replace(".graphql.", ".functions.") + "/webhook";
console.log(`\n✅ Demo workflow ready in Org A: "${NAME}"`);
console.log(`   open: http://localhost:3000/workflows/${wf}`);
console.log(`\n   Fire it via webhook (no button click):`);
console.log(`   curl -sS -X POST ${fnUrl} \\`);
console.log(`     -H 'content-type: application/json' \\`);
console.log(`     -d '{"trigger_id":"${trg}","secret":"${secret}"}'`);
