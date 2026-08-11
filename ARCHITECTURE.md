# ARCHITECTURE — AI Agent Workflow Builder

> **Current milestone: M6 — Broaden + ship** (in progress)
> ✅ All 6 step types + all 4 trigger types implemented and verified. ✅ Turnkey demo
> workflow. **Remaining: deploy to nhost Cloud + Vercel, README + ~1-page write-up,
> recording.**

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

## Execution engine (M2)

**`triggerWorkflowRun(workflow_id)` Action** (`functions/triggerWorkflowRun.ts`) — the
trust boundary. It authorizes via forwarded `session_variables["x-hasura-user-id"]`
(owner/editor in the workflow's org), checks quota, creates the run + a `pending`
step_run per step, then calls `runFrom(run, 0)`. Handler URL is the **internal** cluster
address `http://functions:3000/triggerWorkflowRun` (env `FUNCTIONS_INTERNAL_URL`; the
`/v1` prefix exists only on the public gateway).

**`runFrom(runId, startIndex)`** (`functions/_lib/engine.ts`) — one resumable executor.
Rebuilds context from prior succeeded step outputs, runs steps in order, persists every
transition (`pending → running → succeeded/failed/skipped/awaiting_approval`), pauses on
`approval_gate` (saves `resume_index`), and on terminal completion sets the run status +
increments `organizations.quota_used` exactly once. `llm_call`/`http_request` go through
`withRetry` (≥1 retry; records `attempt` + `error`).

### Step `config` JSONB shapes

Templates `{{ ... }}` in string values resolve against the run context
`{ prev: <last output>, steps: { <position>: <output> } }` — e.g. `{{prev.text}}`,
`{{steps.0.text}}`.

- **`llm_call`** → `{ prompt, system?, model?, temperature?, max_tokens? }`. Real Groq
  chat completion (default model `llama-3.3-70b-versatile`). Output `{ text, model }`.
- **`http_request`** → `{ url, method?, headers?, body? }`. Output `{ status, body }`.
  (Test hook `_test_fail: true` forces failure to exercise the retry path.)
- **`conditional_branch`** → `{ left, operator, right, if_false }` where `operator` ∈
  `contains|not_contains|equals|not_equals|gt|lt` and `if_false` ∈ `skip_next|stop`.
  Output `{ condition, left, operator, right, if_false }`. On a false condition it either
  skips the next step or stops the run — this is how the run "branches on the LLM output".
- **`approval_gate`** → `{}` (M3 adds approver rules). Sets the step to
  `awaiting_approval`, the run to `paused`, and returns.
- **`db_write`** (M6) → `{ data? }`. Inserts a row into `workflow_outputs`
  (defaults to the previous step's output). Owner-only step type.
- **`notify`** (M6) → `{ channel?, message? }`. Inserts a `notifications` row whose INSERT
  fires an **Event Trigger** (`functions/notify.ts`) that delivers it. Owner-only.

Secrets: `GROQ_API_KEY` lives in `.secrets` and is injected to functions via
`nhost.toml` `[[global.environment]]`.

## Triggers

- **manual** — the `triggerWorkflowRun` Action (M2).
- **webhook** (M4) — `functions/webhook.ts`, a public endpoint external systems POST to:
  `POST /v1/webhook { trigger_id, secret }`. It constant-time-compares against the
  trigger's stored `secret` (never exposed via the `user`-role select), checks quota, then
  runs the workflow through the same `createRun` + `runFrom`, so it streams live and sets
  `trigger_type = "webhook"`, `triggered_by = null`. No JWT — the secret is the credential,
  and only an owner can create a webhook trigger (Layer 2).
- **database_event** (M6) — a Hasura **Event Trigger** on INSERT into
  `public.incoming_events` → `functions/onDbEvent.ts`, which starts a run for every
  workflow in that org with an enabled `database_event` trigger.
- **scheduled** (M6) — a Hasura **Cron Trigger** (`cron_triggers.yaml`, every minute) →
  `functions/onSchedule.ts`, which starts a run for every workflow with an enabled
  `scheduled` trigger (no-op when there are none).

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
- **M2 ✅** `triggerWorkflowRun` Action + `runFrom` engine. Verified by
  `web/scripts/verify-m2.mjs`: a manual run of `llm_call` (real Groq) →
  `conditional_branch` (true on "URGENT") → `http_request` streams live (observed
  pending→running→succeeded across snapshots); quota increments; viewer & owner-B are
  rejected by the handler; a forced failure records `attempt = 2` + error.
- **M3 ✅** `approveStep` Action + resume. Verified by `web/scripts/verify-m3.mjs`: a run
  with a mid-pipeline `approval_gate` pauses (`awaiting_approval`, quota untouched);
  viewer and owner-B are rejected by the handler; editor-A approves → the run resumes live
  and completes; `approved_by`/`approved_at` recorded; quota increments once at final
  completion; re-approving a cleared gate → 409.
- **M4 ✅** webhook trigger (`functions/webhook.ts`). Verified by
  `web/scripts/verify-m4.mjs`: an external `fetch` (no auth) with a wrong secret → 401 and
  no run; with the valid secret → a run starts with no button click, streams live, sets
  `trigger_type=webhook`/`triggered_by=null`, completes, and increments quota.
- **M5 ✅ (code)** Next.js UI: `lib/graphql.ts` (nhost SDK for query/mutation + a
  `graphql-ws` `useSubscription` hook), `lib/api.ts` (the 4 named ops), org/workflow list
  + quota, `Builder` (typed steps + triggers, owner/editor gated), and `RunView` (live
  `step_runs` subscription + approve). Data layer verified by `web/scripts/verify-m5.mjs`
  (UI query strings + isolation-returns-null); WS subscription confirmed live. Visual
  browser click-through of the 6-point scenario is the remaining sign-off.
- **M6 (partial)** all 6 step types + 4 trigger types done. `db_write`→`workflow_outputs`,
  `notify`→Event Trigger (`verify-m6.mjs`); `database_event`→Event Trigger on
  `incoming_events`, `scheduled`→Cron (`verify-m6c.mjs`); turnkey `seed-demo.mjs`.
  Remaining: deploy + README/write-up + recording.
