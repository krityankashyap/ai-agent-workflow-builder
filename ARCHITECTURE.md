# ARCHITECTURE — AI Agent Workflow Builder

> **Current milestone: M0 — Skeleton** ✅ complete (awaiting reviewer sign-off)
> nhost stack up, Next.js auth, two orgs + owners seeded, single `user` Hasura role.
> Next: **M1 — full schema + permissions**.

This is the running design log. It records decisions, the JSONB `config` shape per
step type, the status enums, and the current milestone. Keep it current.

---

## Stack (as built)

- **nhost CLI 1.50.1**, local dev via Docker (`nhost up`, branch pinned to `vocal-labs`
  for stable volume names).
- **Hasura** v2.48.10-ce · **Postgres** 14 · **nhost auth** 0.49.1.
- **Frontend:** Next.js 16 (App Router) + React 19 + TypeScript + Tailwind, in `web/`.
- **nhost SDK:** `@nhost/nhost-js` v4 (`createClient`, `auth.*`, `graphql.request`,
  `sessionStorage.onChange`, `withAdminSession` for admin/seed).
- Auth: email+password, `emailVerificationRequired = false` for local demo logins.

## Roles & the isolation model

Exactly **one** authenticated Hasura role: `user` (nhost default). Per-org authority
(`owner` / `editor` / `viewer`) is **data** in `org_members`, not a Hasura role — a user
can be owner in one org and viewer in another simultaneously.

**Every** table's permission filter scopes to the caller via `org_members` keyed on
`X-Hasura-User-Id`. Because the DB enforces this, guessing another org's id returns zero
rows — isolation is by construction, never by hiding ids on the client.

## Schema (M0 subset)

- `organizations` — `id, name, plan, quota_limit, quota_used, quota_period_start,
  created_at, updated_at`. Quota = workflow runs allowed/used per period.
- `org_members` — `id, org_id→organizations, user_id→auth.users, role
  (owner|editor|viewer), created_at`. `UNIQUE(org_id, user_id)`; indexed on both fks.

Relationships tracked: `organizations.members` (array → org_members),
`org_members.organization` (object → organizations).

### The permission expression (the one to explain live)

`organizations` SELECT (role `user`):
```yaml
filter:
  members:
    user_id: { _eq: X-Hasura-User-Id }
```
`org_members` SELECT (role `user`) — "any member of an org I belong to":
```yaml
filter:
  organization:
    members:
      user_id: { _eq: X-Hasura-User-Id }
```

Later milestones add owner/editor INSERT/UPDATE/DELETE filters (adding a
`role: { _in: [owner, editor] }` clause) and the Layer‑2 owner-only step gating.

## Status enums (planned, applied via CHECK constraints)

- `workflow_runs.status`: `pending | running | paused | succeeded | failed`
- `step_runs.status`: `pending | running | awaiting_approval | succeeded | failed | skipped`

(Defined for real in M1/M2.)

## Step `config` JSONB shapes

_TBD in M2 — one documented shape per step type (`llm_call`, `http_request`,
`conditional_branch`, `approval_gate`, `db_write`, `notify`)._

## Seed (M0)

`web/scripts/seed.mjs` (idempotent): creates `owner-a@example.com` and
`owner-b@example.com` via the real auth signup flow, then an admin GraphQL client writes
two orgs (Acme=Org A, Globex=Org B) and one `owner` membership each in different orgs.

## Local dev — how to run (verified commands)

```bash
# 1. Start the backend (Docker images cached; run from repo root)
nhost up --branch vocal-labs           # Hasura https://local.hasura.local.nhost.run
                                       # GraphQL https://local.graphql.local.nhost.run

# 2. Apply Hasura metadata (CLI wrapper needs explicit endpoint + admin secret;
#    nhost's config.yaml only sets `version`, so the CLI otherwise hits :8080)
SECRET=$(docker exec vocal-labs-graphql-1 printenv HASURA_GRAPHQL_ADMIN_SECRET)
nhost dev hasura metadata apply \
  --endpoint https://local.hasura.local.nhost.run --admin-secret "$SECRET"

# 3. Seed two orgs + owners (from web/)
cd web && NHOST_ADMIN_SECRET="$SECRET" node scripts/seed.mjs

# 4. Frontend
cd web && npm run dev                  # http://localhost:3000
```

Gotchas learned:
- Local admin secret is the default `nhost-admin-secret` (stored single-quoted in
  `.secrets`; strip quotes when parsing, or read it from the container as above).
- `nhost up` starts the stack **detached** and exits; containers keep running.
- Docker Hub serves image blobs via AWS CloudFront — some networks block it; a mobile
  hotspot was the workaround here.

## Milestone log

- **M0 ✅** scaffold, auth, orgs+members schema+perms, seed. Verified: owner-a sees only
  Acme (Org A), owner-b only Globex (Org B); owner-a probing Org B by direct id → `[]`
  (`web/scripts/verify-m0.mjs` passes).
