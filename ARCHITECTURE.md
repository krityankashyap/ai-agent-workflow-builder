# ARCHITECTURE — AI Agent Workflow Builder

> **Current milestone: M1 — Schema + permissions** ✅ complete (awaiting reviewer sign-off)
> Full workflow-engine schema, both permission layers, and the aggregation view — all
> tracked. Next: **M2 — execution engine (`triggerWorkflowRun` + `runFrom`)**.

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

## Schema

- `organizations` — `id, name, plan, quota_limit, quota_used, quota_period_start, …`.
  Quota = workflow runs allowed/used per period.
- `org_members` — `id, org_id→organizations, user_id→auth.users, role
  (owner|editor|viewer)`. `UNIQUE(org_id, user_id)`; indexed on both fks.
- `workflows` — `id, org_id→organizations, name, description, created_by→auth.users`.
- `workflow_steps` — `id, workflow_id→workflows, position, type, config (jsonb)`. Ordered.
- `workflow_triggers` — `id, workflow_id→workflows, type, config (jsonb), secret, enabled`.
  `secret` is NOT selectable via the `user` role (webhook token must not leak).
- `workflow_runs` — `id, workflow_id→workflows, org_id (denormalized), status,
  resume_index, trigger_type, triggered_by, error, started_at, finished_at`.
- `step_runs` — `id, run_id→workflow_runs, step_id→workflow_steps (SET NULL),
  position, step_type, status, input, output, error, attempt, approved_by, approved_at,
  started_at, finished_at`. Position/type snapshotted so run history survives step edits.

Relationships tracked: `organizations.members`; `workflows.{org,steps,triggers,runs,stats}`;
`workflow_steps.workflow`; `workflow_triggers.workflow`;
`workflow_runs.{workflow,org,step_runs}`; `step_runs.{run,step}`;
`workflow_run_stats.organization` (manual, view has no FK).

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

### Two permission layers, enforced by different mechanisms

**Layer 1 — org + role scoping** (on every table). SELECT = any member; write =
`role: { _in: [owner, editor] }` (workflow DELETE = `owner` only). Same relational shape,
one hop further for nested tables (`workflow_steps` → `workflow.org.members`, `step_runs`
→ `run.org.members`).

**Layer 2 — step-level owner-only gating** on the *insert/update `check`* of
`workflow_steps` and `workflow_triggers`, keyed on the row's `type`:

```yaml
# workflow_steps INSERT check — db_write/notify require owner; others owner|editor
check:
  _or:
    - _and: [ { type: { _nin: [db_write, notify] } }, <workflow.org.members role in [owner,editor]> ]
    - _and: [ { type: { _in:  [db_write, notify] } }, <workflow.org.members role = owner> ]
```
`workflow_triggers` uses the same shape with `webhook` as the owner-only type. The other
half of Layer 2 (clearing an `approval_gate`) is a *mid-execution* decision and lives in
the `approveStep` handler (M3), not a row permission.

**Runs are handler-only.** `workflow_runs` / `step_runs` grant the `user` role SELECT
**only** — they are created and advanced exclusively by the Action handlers (admin), which
is where quota and approver-role are enforced in code. This is why direct-ID guessing and
direct row writes both return nothing.

## Status enums (live, enforced via CHECK constraints)

- `workflow_runs.status`: `pending | running | paused | succeeded | failed`
- `step_runs.status`: `pending | running | awaiting_approval | succeeded | failed | skipped`
- `workflow_steps.type`: `llm_call | http_request | db_write | notify | conditional_branch | approval_gate`
- `workflow_triggers.type`: `manual | webhook | scheduled | database_event`

## Aggregation

`workflow_run_stats` — a Postgres VIEW: per workflow, `total/succeeded/failed/paused_runs`
and `avg_duration_seconds` (avg of `finished_at - started_at`). Tracked in Hasura, scoped
to the caller's org via a manual `organization` relationship.

## Step `config` JSONB shapes

_TBD in M2 — one documented shape per step type (`llm_call`, `http_request`,
`conditional_branch`, `approval_gate`, `db_write`, `notify`)._

## Seed

`web/scripts/seed.mjs` (idempotent): creates users via the real auth signup flow, then an
admin GraphQL client writes two orgs and their memberships:
- **Acme (Org A):** `owner-a` (owner), `editor-a` (editor), `viewer-a` (viewer)
- **Globex (Org B):** `owner-b` (owner)

All passwords `password123`. The three Org-A roles exist to demonstrate both permission
layers (viewer can't create; editor can't add `db_write`/`webhook`; owner can).

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
- **M1 ✅** full workflow-engine schema (5 tables + `workflow_run_stats` view), all
  relationships, both permission layers. Verified by `web/scripts/verify-m1.mjs` (14
  checks): owner-A builds a workflow; owner-B can't read its workflow/steps/triggers or
  inject a step by exact id; viewer can't create, editor can; editor can't add
  `db_write`/`webhook`, owner can; stats view is org-scoped.
