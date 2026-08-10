// M0 verification: each user sees only their own org, and a cross-org
// direct-ID probe returns nothing. Run after seeding.
import { createClient } from "@nhost/nhost-js";

const NHOST = { subdomain: "local", region: "local" };

async function asUser(email, password) {
  const c = createClient(NHOST);
  await c.auth.signInEmailPassword({ email, password });
  return c;
}

async function q(client, query, variables) {
  const r = await client.graphql.request({ query, variables });
  if (r.body.errors?.length)
    throw new Error(r.body.errors.map((e) => e.message).join("; "));
  return r.body.data;
}

const MY_ORGS = `query { org_members { role organization { id name } } }`;
const ORG_BY_ID = `query ($id: uuid!) {
  organizations(where: { id: { _eq: $id } }) { id name }
}`;

const a = await asUser("owner-a@example.com", "password123");
const b = await asUser("owner-b@example.com", "password123");

const aOrgs = (await q(a, MY_ORGS)).org_members;
const bOrgs = (await q(b, MY_ORGS)).org_members;

console.log("Owner A sees:", aOrgs.map((m) => `${m.organization.name} (${m.role})`));
console.log("Owner B sees:", bOrgs.map((m) => `${m.organization.name} (${m.role})`));

const orgBId = bOrgs[0].organization.id;
const probe = (await q(a, ORG_BY_ID, { id: orgBId })).organizations;
console.log(`\nOwner A probing Org B by id (${orgBId}):`, probe);

// Assertions
const ok =
  aOrgs.length === 1 &&
  aOrgs[0].organization.name.includes("Org A") &&
  bOrgs.length === 1 &&
  bOrgs[0].organization.name.includes("Org B") &&
  probe.length === 0;

console.log(ok ? "\n✅ M0 ISOLATION PASSES" : "\n❌ M0 ISOLATION FAILED");
process.exit(ok ? 0 : 1);
