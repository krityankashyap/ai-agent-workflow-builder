# AI Agent Workflow Builder

A "mini n8n" for chaining AI‑agent steps. Organizations build workflows out of typed
steps, start them multiple ways, watch them run live, and every action passes through
**two independent permission layers** with airtight cross‑org isolation.

Built on **nhost** (Postgres + Hasura + Auth + Functions) with a **Next.js** frontend.

## Architecture in one paragraph

There is exactly **one** authenticated Hasura role (`user`). Per‑org authority
(`owner` / `editor` / `viewer`) is stored **relationally** in `org_members`, so a user can
be owner in one org and viewer in another. Every table's permission filter scopes rows to
the caller via `org_members` keyed on `X-Hasura-User-Id` — so guessing another org's id
returns zero rows (isolation by construction, not by hiding ids). The serverless **Action
handlers are the trust boundary**: they run with admin DB access and re‑authorize every
call using the forwarded, unforgeable session variables. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design log and [`WRITEUP.md`](./WRITEUP.md)
for the ~1‑page summary.

## Features

- **Step types:** `llm_call` (real Groq API, with retry), `http_request` (with retry),
  `conditional_branch` (if/else on a prior step's output), `approval_gate` (pause →
  human approval → resume), `db_write` (persist to a table), `notify` (**Hasura Event
  Trigger**).
- **Trigger types:** `manual` (Action), `webhook` (public endpoint authed by a secret),
  `database_event` (**Event Trigger** on a watched table), `scheduled` (**Cron Trigger**).
- **Two permission layers:** (1) org+role scoping on every table; (2) owner‑only gating
  for `db_write`/`notify` steps and `webhook` triggers (DB check) **plus** the
  `approval_gate` role re‑check in the `approveStep` handler.
- **Live execution:** every step transition is persisted, streamed to the UI via a
  `graphql-ws` subscription (incl. the paused state) — no refresh.
- **Quota** per org (checked before a run, incremented on completion) with a UI indicator.

## Tech stack

- nhost CLI (local Docker dev) · Hasura v2.48 · PostgreSQL 14 · nhost Auth · Functions (Node 22)
- Next.js 16 (App Router) · React 19 · TypeScript · Tailwind · `@nhost/nhost-js` v4 · `graphql-ws`
- LLM: **Groq** free tier (`llama-3.3-70b-versatile`)

## Prerequisites

- [nhost CLI](https://docs.nhost.io/platform/cli) — `brew install nhost/tap/nhost`
- Docker (Docker Desktop running)
- Node 22+
- A **Groq API key** (free at console.groq.com) — or run with a stub (see below)

## Run it locally

```bash
# 0. Put your Groq key in the (gitignored) secrets file:
echo "GROQ_API_KEY = 'gsk_...'" >> .secrets

# 1. Start the backend. First run pulls Docker images. This applies the DB
#    migrations AND the Hasura metadata (tables, relationships, both permission
#    layers, Actions, Event/Cron Triggers).
nhost up --branch vocal-labs

# 2. Seed two orgs with roles, then a turnkey demo workflow (both idempotent).
cd web
npm install
SECRET=$(docker exec vocal-labs-graphql-1 printenv HASURA_GRAPHQL_ADMIN_SECRET)
NHOST_ADMIN_SECRET="$SECRET" node scripts/seed.mjs
node scripts/seed-demo.mjs

# 3. Frontend.
npm run dev            # http://localhost:3000
```

> **Local DNS note (important on some networks):** the local stack is reached at
> `*.local.nhost.run`, which resolves to `127.0.0.1` via public DNS. Some networks
> (hotspots, corporate/ISP DNS with rebind protection) refuse to resolve loopback and the
> app can't reach the backend. Fix it once, network‑independent:
> ```
> echo "127.0.0.1 local.nhost.run local.auth.local.nhost.run local.graphql.local.nhost.run local.hasura.local.nhost.run local.storage.local.nhost.run local.functions.local.nhost.run local.dashboard.local.nhost.run local.mailhog.local.nhost.run" | sudo tee -a /etc/hosts
> ```

### Demo logins (after `seed.mjs`)

| Email | Password | Org / role |
|---|---|---|
| `owner-a@example.com` | `password123` | Acme (Org A) — **owner** |
| `editor-a@example.com` | `password123` | Acme (Org A) — **editor** |
| `viewer-a@example.com` | `password123` | Acme (Org A) — **viewer** |
| `owner-b@example.com` | `password123` | Globex (Org B) — **owner** |

`seed-demo.mjs` prints the demo workflow URL and a ready `curl` to fire it via webhook.

### The Final-Task scenario (live)

1. Sign in as **owner‑a** → open the "Support triage demo" workflow.
2. **Run** it → steps stream live; it **pauses** at the `approval_gate`.
3. **Approve** → it resumes and completes, no refresh. (Also fire it via the printed
   webhook `curl` — no button click.)
4. Sign in as **viewer‑a** → **no Run button**. Sign in as **owner‑b** → can't see Org A's
   workflow, and opening the Org A workflow URL shows **"Workflow not found"**.

## Verification scripts

Each milestone has a runnable proof under `web/scripts/` (run from `web/`):

| Script | Proves |
|---|---|
| `verify-m0.mjs` | each user sees only their own org; cross‑org id probe → `[]` |
| `verify-m1.mjs` | both permission layers (14 checks) |
| `verify-m2.mjs` | manual run: Groq + http + branch, live, quota, retry |
| `verify-m3.mjs` | approval gate: pause → deny → approve → resume live |
| `verify-m4.mjs` | webhook starts a run from an external POST |
| `verify-m5.mjs` | UI query strings + in‑UI isolation |
| `verify-m6.mjs` | `db_write` row + `notify` Event Trigger delivery |
| `verify-m6c.mjs` | `database_event` + `scheduled` triggers |

## Secrets & env

No secrets are committed. `.secrets` (gitignored) holds the local admin secret (default
`nhost-admin-secret`), JWT keys, and `GROQ_API_KEY`. `nhost.toml` injects `GROQ_API_KEY`
and the internal Functions URLs into services via `[[global.environment]]`.

## Deployment

**Live app:** https://ai-agent-workflow-builder-krityankashyaps-projects.vercel.app
(frontend on Vercel, backend on nhost Cloud — subdomain `fcwebehyitncvjusmahj`, region
`ap-south-1`). Demo logins are seeded (all `password123`): `owner-a@example.com`,
`editor-a@example.com`, `viewer-a@example.com`, `owner-b@example.com`.

> **nhost Cloud networking note:** Cloud has no internal `graphql`/`functions` service DNS
> like local docker, so the Function→GraphQL calls use `NHOST_GRAPHQL_URL` (handled in
> `functions/_lib/hasura.ts`) and the three `*_URL` secrets are set to the **public**
> functions URL (`https://<subdomain>.functions.<region>.nhost.run/v1[/name]`).

### Backend → nhost Cloud
1. Create a free project at [app.nhost.io](https://app.nhost.io) and connect this GitHub
   repo (nhost auto‑deploys the `nhost/` migrations + metadata and the `functions/`).
2. In the project's **Secrets**, set:
   | Secret | Value |
   |---|---|
   | `GROQ_API_KEY` | your Groq key |
   | `FUNCTIONS_INTERNAL_URL` | `http://functions:3000` |
   | `NOTIFY_WEBHOOK_URL` | `http://functions:3000/notify` |
   | `DBEVENT_WEBHOOK_URL` | `http://functions:3000/onDbEvent` |

   nhost Cloud uses the same internal service networking as local, so the internal
   URLs work. If Actions/triggers can't reach Functions, switch these to the public
   form `https://<subdomain>.functions.<region>.nhost.run/v1[/name]`.
3. Set the Auth **client URL / allowed redirect** to your Vercel URL.

### Frontend → Vercel
1. Import the repo, **root directory = `web/`** (framework auto‑detected: Next.js).
2. Env vars: `NEXT_PUBLIC_NHOST_SUBDOMAIN` and `NEXT_PUBLIC_NHOST_REGION` (from the nhost
   project's dashboard). Deploy → live URL.

### Seed the cloud
Point the seed scripts at the cloud project and run them once:
```bash
cd web
NEXT_PUBLIC_NHOST_SUBDOMAIN=<sub> NEXT_PUBLIC_NHOST_REGION=<region> \
  NHOST_ADMIN_SECRET=<cloud admin secret> node scripts/seed.mjs
# then seed-demo.mjs (uses the same env)
```

## Repo layout

- `nhost/` — migrations, metadata (schema + both permission layers + Actions/Event/Cron)
- `functions/` — handlers: `triggerWorkflowRun`, `approveStep`, `webhook`, `notify`,
  `onDbEvent`, `onSchedule`, and `_lib/` (engine, authz, steps, hasura)
- `web/` — Next.js frontend + `scripts/` (seed + per‑milestone verification)
- `ASSIGNMENT.md` · `CLAUDE.md` · `ARCHITECTURE.md` · `WRITEUP.md`
