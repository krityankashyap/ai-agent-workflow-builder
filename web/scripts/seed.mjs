// Seed script for M0: two organizations, each with an owner in a different org.
// Idempotent — safe to run multiple times.
//
//   NHOST_ADMIN_SECRET=... node scripts/seed.mjs
//
// Users are created through the real Auth signup flow (so password hashing /
// auth.users columns are handled by the auth service, not us). Orgs and
// memberships are written with an admin GraphQL client that bypasses row
// permissions — seeding is a trusted, out-of-band operation.

import { createClient, withAdminSession } from "@nhost/nhost-js";

const adminSecret = process.env.NHOST_ADMIN_SECRET;
if (!adminSecret) {
  console.error("Missing NHOST_ADMIN_SECRET env var");
  process.exit(1);
}

const NHOST = {
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN ?? "local",
  region: process.env.NEXT_PUBLIC_NHOST_REGION ?? "local",
};

// Public client for auth signups/signins (acts as an anonymous end user).
const auth = createClient(NHOST);
// Admin client for writing seed rows (bypasses Hasura permissions).
const admin = createClient({
  ...NHOST,
  configure: [withAdminSession({ adminSecret })],
});

const USERS = [
  { key: "ownerA", email: "owner-a@example.com", password: "password123" },
  { key: "editorA", email: "editor-a@example.com", password: "password123" },
  { key: "viewerA", email: "viewer-a@example.com", password: "password123" },
  { key: "ownerB", email: "owner-b@example.com", password: "password123" },
];

const ORGS = [
  { key: "orgA", name: "Acme Inc (Org A)" },
  { key: "orgB", name: "Globex (Org B)" },
];

// A user can hold different roles in different orgs — the whole point of keeping
// roles relational. Org A has all three roles; Org B has its own owner.
const MEMBERSHIPS = [
  { orgKey: "orgA", userKey: "ownerA", role: "owner" },
  { orgKey: "orgA", userKey: "editorA", role: "editor" },
  { orgKey: "orgA", userKey: "viewerA", role: "viewer" },
  { orgKey: "orgB", userKey: "ownerB", role: "owner" },
];

async function gql(query, variables) {
  const resp = await admin.graphql.request({ query, variables });
  if (resp.body.errors?.length) {
    throw new Error(resp.body.errors.map((e) => e.message).join("; "));
  }
  return resp.body.data;
}

// Create the user via signup; if the email already exists, sign in instead.
// Either way we return the auth user id.
async function ensureUser({ email, password }) {
  try {
    const resp = await auth.auth.signUpEmailPassword({ email, password });
    const id = resp.body.session?.user?.id;
    if (id) {
      console.log(`  created user ${email} (${id})`);
      return id;
    }
  } catch {
    // Fall through to sign-in on "email already in use".
  }
  const resp = await auth.auth.signInEmailPassword({ email, password });
  const id = resp.body.session?.user?.id;
  if (!id) throw new Error(`Could not resolve user id for ${email}`);
  console.log(`  found existing user ${email} (${id})`);
  return id;
}

// Find an org by name or insert it. (No unique constraint on name, so we look
// it up first to stay idempotent.)
async function ensureOrg(name) {
  const found = await gql(
    `query ($name: String!) {
       organizations(where: { name: { _eq: $name } }, limit: 1) { id }
     }`,
    { name }
  );
  if (found.organizations.length > 0) return found.organizations[0].id;

  const inserted = await gql(
    `mutation ($name: String!) {
       insert_organizations_one(object: { name: $name }) { id }
     }`,
    { name }
  );
  return inserted.insert_organizations_one.id;
}

// Insert membership; do nothing if (org_id, user_id) already exists.
async function ensureMembership(orgId, userId, role) {
  await gql(
    `mutation ($orgId: uuid!, $userId: uuid!, $role: String!) {
       insert_org_members_one(
         object: { org_id: $orgId, user_id: $userId, role: $role }
         on_conflict: { constraint: org_members_org_id_user_id_key, update_columns: [role] }
       ) { id }
     }`,
    { orgId, userId, role }
  );
}

async function main() {
  console.log("Seeding users…");
  const userIds = {};
  for (const u of USERS) {
    userIds[u.key] = await ensureUser(u);
  }

  console.log("Seeding organizations…");
  const orgIds = {};
  for (const o of ORGS) {
    orgIds[o.key] = await ensureOrg(o.name);
    console.log(`  ${o.name} (${orgIds[o.key]})`);
  }

  console.log("Seeding memberships…");
  for (const m of MEMBERSHIPS) {
    await ensureMembership(orgIds[m.orgKey], userIds[m.userKey], m.role);
    console.log(`  ${m.orgKey}: ${m.userKey} → ${m.role}`);
  }

  console.log("\nDone. Demo logins (all password123):");
  for (const u of USERS) console.log(`  ${u.email}`);
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
