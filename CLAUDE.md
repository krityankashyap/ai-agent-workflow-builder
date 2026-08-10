# CLAUDE.md — AI Agent Workflow Builder

## What this is
A "mini n8n" for chaining AI-agent steps. Organizations build workflows out of typed
steps, start them multiple ways, and every action passes through **two independent
permission layers**. The whole project is judged by **one live end-to-end scenario**
(see "Definition of done"), weighted above everything else — not a feature checklist.
If that scenario breaks in the live walkthrough, nothing else counts. "Submitted early
but broken" is explicitly penalized, so the priority order is: **correct → working →
demoable → fast**.

## Stack
- nhost (Postgres + Hasura + Auth + Storage + serverless Functions)
- Hasura GraphQL Engine — queries, mutations, subscriptions, **Actions**, **Event
  Triggers**, **Cron/Scheduled Triggers**
- PostgreSQL (schema managed via Hasura migrations)
- Next.js (App Router) + TypeScript frontend; nhost JS SDK + a GraphQL client
  (Apollo or urql) with a WebSocket link for subscriptions
- LLM for `llm_call`: a free tier (Groq / OpenRouter / Gemini). If unavailable, a
  stubbed call with a *disclosed* artificial delay is acceptable.

## Commands
<!-- Keep these current as the project is set up. Verify exact commands/paths against
     nhost + Hasura docs — do NOT assume; these tools change. -->
- Local backend: `nhost up`
- Migrations / metadata: `nhost` migrate + metadata apply (confirm exact subcommands)
- Frontend dev: `pnpm dev` (in `web/`)
- Deploy: Vercel (frontend) + nhost project (backend)

## Repo layout
- `nhost/` — Hasura migrations, metadata, seed data
- `functions/` — serverless handlers: Action handlers (`triggerWorkflowRun`,
  `approveStep`), Event Trigger handlers (`notify`, DB-event → run), Cron handler
- `web/` — Next.js frontend
- `ASSIGNMENT.md` — the full spec (source of truth for requirements)
- `ARCHITECTURE.md` — running design log: schema decisions, per-step JSONB `config`
  shapes, status enums, and the CURRENT build milestone
- This file — durable rules; assume it's read every session

## Architecture invariants — these MUST always hold

1. **Per-org roles are relational, never global Hasura roles.**
   A user can be `owner` in Org A and `viewer` in Org B *at the same time*. Therefore
   there is exactly **one** authenticated Hasura role (`user`). All org + role scoping
   is enforced by **relational permission filters** against `org_members` keyed on
   `X-Hasura-User-Id`. Do NOT bake owner/editor/viewer into the JWT as separate Hasura
   roles, and do NOT switch roles per request.

2. **Cross-org isolation is enforced by the permission filter, not the query.**
   Every table's select/insert/update/delete permission scopes to rows whose org has an
   `org_members` row matching `{ user_id: X-Hasura-User-Id }` (plus a `role` filter when
   the action needs one). Because the DB enforces this, guessing another org's
   `workflow_id` / `run_id` / `step_run_id` returns nothing. Isolation is airtight *by
   construction* — never by the client hiding IDs.

3. **Action handlers are the trust boundary.**
   `triggerWorkflowRun` and `approveStep` run with admin DB access — they can read/write
   anything. They therefore MUST authorize every call themselves using
   `session_variables["x-hasura-user-id"]` (Hasura-forwarded from the validated JWT,
   unforgeable): look up the caller's role in the *workflow's* org via `org_members` and
   reject if insufficient. NEVER trust the Action `input` for identity or authority.

4. **Two permission layers, enforced by different mechanisms.**
   - Layer 1 (DB permissions): org + role scoping on every table (invariants 1–2).
     `owner` full control; `editor` create/edit workflows+steps and trigger runs, no
     member management; `viewer` read-only, cannot trigger.
   - Layer 2 (step-level gating): only `owner` may insert a `db_write` step, a `notify`
     step, or a `webhook` trigger (DB permission). Clearing an `approval_gate` is a
     *mid-execution* decision — `approveStep` re-checks the approver's role **in handler
     code** before resuming. This cannot be a row permission.

5. **Execution is resumable from a step index.**
   One function `runFrom(workflow_run_id, startIndex)` executes steps in order.
   `triggerWorkflowRun` calls it with `startIndex = 0`. On an `approval_gate`, it sets
   the step_run to `awaiting_approval`, the run to `paused`, persists the resume index,
   and returns. `approveStep` (after authz) calls `runFrom` at the next index. ALL state
   lives in `workflow_runs` + `step_runs` — no in-memory continuation.

6. **Subscriptions are database-backed.**
   Live per-step progress is a subscription on `step_runs` filtered by
   `workflow_run_id`. The handler MUST persist every status transition as it happens
   (`pending → running → succeeded/failed`, plus `awaiting_approval` / `paused`) so the
   UI updates with no refresh.

7. **External calls retry; quota is enforced.**
   `llm_call` and `http_request` make real external calls with **at least one retry** on
   failure, recording `attempt` count and `error` on the step_run. `triggerWorkflowRun`
   checks the org's quota BEFORE running and increments usage on completion.

## Data model — relationships that must hold
`organizations → org_members → workflows → (workflow_steps | workflow_triggers)`;
`workflows → workflow_runs → step_runs`.
- `organizations`: usage quota (calls used / allowed per period).
- `org_members`: `user_id`, `org_id`, `role` (owner | editor | viewer).
- `workflow_steps`: ordered, `type`, `config` (JSONB).
- `workflow_runs.status`: must support `paused`.
- `step_runs`: `status`, `input`, `output`, `error`, `attempt`, `approved_by`,
  `approved_at`.
- One aggregation exposed as a **Postgres view or computed field** (org usage this
  month, or average run duration).

## Step & trigger types
- Steps: `llm_call`, `http_request`, `db_write`, `notify` (implemented as an Event
  Trigger), `conditional_branch` (if/else on previous step output), `approval_gate`.
- Triggers: `manual`, `webhook` (inbound endpoint that starts a run), `scheduled`
  (cron), `database_event` (watched-table row change via Event Trigger).

## Conventions
- `config` is JSONB per step. Document each type's exact shape in ARCHITECTURE.md and
  keep it stable once code depends on it.
- Status values: use one enum table (or a checked text column) applied consistently to
  `workflow_runs` and `step_runs`.
- Name the four required GraphQL ops explicitly: (a) org workflows with steps + triggers
  + latest run status; (b) upsert workflow + steps + triggers; (c) `approveStep`
  mutation; (d) `step_runs` subscription filtered by `workflow_run_id`.
- Secrets via env / nhost secrets only. README documents every env var, or notes the
  stub.

## Definition of done — the only grade that matters
The live scenario, end to end, no refresh:
1. Two orgs, each with their own users + roles.
2. Org A owner builds a workflow with ≥3 step types incl. one `llm_call`, one
   `http_request`, and one `conditional_branch` whose path depends on the LLM output.
3. Startable two ways: manual **and** webhook/event trigger.
4. An `approval_gate` pauses the run; only an owner/editor in that org can approve.
5. Live step-by-step status via subscription, including the paused state.
6. An Org B user cannot see, trigger, or approve any Org A resource — **including by
   guessing an ID directly**.

Deliverables: GitHub repo + README (setup, how to run, API keys or stub note); deployed
Vercel URL; Hasura migrations/metadata showing schema + both permission layers; ~1-page
write-up (schema reasoning, how the two layers are enforced *differently*, how the
approval-gate pause/resume works); short recording of the scenario.

## Do NOT
- Do NOT rely on DB permissions alone and assume the Action handler is safe — reviewers
  check that gating is enforced IN the handler.
- Do NOT trust the Action `input` for who the caller is — use forwarded
  `session_variables`.
- Do NOT use global owner/editor/viewer Hasura roles or per-request role switching.
- Do NOT make ID-hiding on the client your isolation mechanism — it must hold against
  direct ID guessing.
- Do NOT skip the retry on external calls, or the quota check/increment.
- Do NOT hardcode secrets or commit keys.

## Build order
Ship a thin **vertical slice** of the Final Task first, deploy it, then broaden. The
current milestone is tracked at the top of ARCHITECTURE.md.