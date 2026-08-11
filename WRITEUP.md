# Write-up — AI Agent Workflow Builder

## Schema reasoning

The data model follows the required spine —
`organizations → org_members → workflows → (workflow_steps | workflow_triggers)` and
`workflows → workflow_runs → step_runs` — with a few deliberate choices:

- **Roles live in `org_members`, not the JWT.** The same person can be `owner` in one org
  and `viewer` in another simultaneously, so authority is *relational data* keyed on
  `(org_id, user_id)`, and there is exactly **one** Hasura role (`user`). This is the
  single most important decision: it makes org+role scoping expressible as a permission
  filter on every table rather than as global roles or per-request role switching.
- **`workflow_runs.org_id` is denormalized.** Runs and step_runs are the hot, high-volume
  tables and the subscription target, so carrying `org_id` on the run keeps their
  permission filter one hop shorter (`run.org.members` instead of
  `run.workflow.org.members`).
- **`step_runs` snapshot `position` and `step_type`.** A run is a historical record; if a
  step definition is later edited or deleted (`step_id` is `ON DELETE SET NULL`), the run
  still reads correctly.
- **Status/type domains are `CHECK` constraints** (one source of truth, mirrored in
  `ARCHITECTURE.md`) so bad states can't be written even by the admin handlers.
- **One aggregation** is a Postgres **view**, `workflow_run_stats` (avg run duration +
  run counts per workflow), tracked in Hasura and scoped to the caller's org via a manual
  relationship.

## The two permission layers, enforced *differently*

**Layer 1 — org + role scoping (declarative, in the database).** Every table's Hasura
permission filters rows through `org_members` on `X-Hasura-User-Id`:

```yaml
# workflows SELECT: any member of the org
filter: { org: { members: { user_id: { _eq: X-Hasura-User-Id } } } }
# workflows INSERT/UPDATE: owner or editor
check:  { org: { members: { user_id: { _eq: X-Hasura-User-Id }, role: { _in: [owner, editor] } } } }
```

Because the **database** enforces this, guessing another org's `workflow_id` / `run_id` /
`step_run_id` returns nothing — isolation is airtight *by construction*, never by the
client hiding ids.

**Layer 2 — step-level gating (two mechanisms).**
1. *Row-level, in the DB:* only an `owner` may insert a `db_write`/`notify` step or a
   `webhook` trigger. This is an `_or` **check** on the row's `type`:
   ```yaml
   check:
     _or:
       - _and: [ { type: { _nin: [db_write, notify] } }, <members role in [owner,editor]> ]
       - _and: [ { type: { _in:  [db_write, notify] } }, <members role = owner> ]
   ```
2. *In handler code:* clearing an `approval_gate` is a **mid-execution decision**, not a
   row read/write, so it can't be a row permission. The `approveStep` handler re-looks-up
   the caller's role in the run's org and rejects anyone who isn't owner/editor **before**
   resuming.

Both `workflow_runs` and `step_runs` are **select-only** for the `user` role. Runs are
created and advanced exclusively by the Action handlers, which run with admin access and
are therefore the **trust boundary**: they authorize every call using Hasura's forwarded
`session_variables["x-hasura-user-id"]` (derived from the validated JWT — unforgeable) and
never trust the action input for identity. That is why a viewer (or another org's user)
cannot trigger or approve anything even though the mutation exists in the schema.

## How the approval-gate pause/resume works

Execution is one resumable function, `runFrom(run_id, startIndex)`, and **all state lives
in the database** — there is no in-memory continuation.

1. `triggerWorkflowRun` authorizes owner/editor, checks quota, creates the run and a
   `pending` `step_run` per step, then calls `runFrom(run, 0)`. Each step transition
   (`pending → running → succeeded/failed/skipped`) is persisted as it happens, so the
   `graphql-ws` subscription streams progress with no refresh.
2. On hitting an `approval_gate`, `runFrom` sets that `step_run` to `awaiting_approval`,
   the run to `paused`, persists `resume_index = gate position`, and **returns**. Quota is
   *not* incremented (the run isn't terminal).
3. `approveStep(step_run_id)` loads the gate → run → org, verifies it is
   `awaiting_approval`, **re-checks** the caller is owner/editor (Layer 2), records
   `approved_by`/`approved_at`, clears the gate, and calls `runFrom(run, gate + 1)`.
4. `runFrom` rebuilds its context from the already-succeeded steps' outputs and continues.
   On terminal completion it sets the run status and increments the org's quota exactly
   once. The subscription shows the whole pause → approve → resume live.

The same `createRun` + `runFrom` pair backs every trigger type (manual Action, webhook
endpoint, `database_event` Event Trigger, `scheduled` Cron Trigger), so they all stream
live and enforce the same rules.
