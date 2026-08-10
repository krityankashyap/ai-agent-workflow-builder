# AI Agent Workflow Builder

A "mini n8n" for chaining AI‑agent steps. Organizations build workflows out of typed
steps (`llm_call`, `http_request`, `conditional_branch`, `approval_gate`, …), start them
multiple ways, and every action passes through **two independent permission layers** with
airtight cross‑org isolation.

Built on **nhost** (Postgres + Hasura + Auth + Functions) with a **Next.js** frontend.

> **Status:** M0 (skeleton) complete — auth, two orgs with per‑org roles, and cross‑org
> isolation enforced by Hasura permissions. See [`ARCHITECTURE.md`](./ARCHITECTURE.md)
> for the design log and current milestone.

## Architecture in one paragraph

There is exactly **one** authenticated Hasura role (`user`). Per‑org authority
(`owner` / `editor` / `viewer`) is stored **relationally** in `org_members`, so a user can
be owner in one org and viewer in another. Every table's permission filter scopes rows to
the caller via `org_members` keyed on `X-Hasura-User-Id` — guessing another org's id
returns zero rows. Action handlers (the trust boundary) re‑authorize each call using the
forwarded, unforgeable session variables.

## Tech stack

- nhost CLI (local Docker dev) · Hasura v2.48 · PostgreSQL 14 · nhost Auth
- Next.js 16 (App Router) · React 19 · TypeScript · Tailwind
- `@nhost/nhost-js` v4 SDK

## Prerequisites

- [nhost CLI](https://docs.nhost.io/platform/cli) (`brew install nhost/tap/nhost`)
- Docker (Docker Desktop running)
- Node 22+

## Run it locally

```bash
# 1. Start the backend (from repo root). First run pulls Docker images.
nhost up --branch vocal-labs
#    Hasura   -> https://local.hasura.local.nhost.run
#    GraphQL  -> https://local.graphql.local.nhost.run

# 2. Apply Hasura metadata (tables, relationships, permissions).
SECRET=$(docker exec vocal-labs-graphql-1 printenv HASURA_GRAPHQL_ADMIN_SECRET)
nhost dev hasura metadata apply \
  --endpoint https://local.hasura.local.nhost.run --admin-secret "$SECRET"

# 3. Seed two orgs + owners (idempotent).
cd web
NHOST_ADMIN_SECRET="$SECRET" node scripts/seed.mjs

# 4. Frontend.
npm install
npm run dev            # http://localhost:3000
```

### Demo logins (after seeding)

| Email | Password | Sees |
|---|---|---|
| `owner-a@example.com` | `password123` | Acme Inc (Org A) — owner |
| `owner-b@example.com` | `password123` | Globex (Org B) — owner |

Each user sees **only their own org**. Verify isolation directly:

```bash
cd web && node scripts/verify-m0.mjs   # signs in as each user, probes cross-org by id
```

## Secrets

No secrets are committed. Local secrets live in `.secrets` (gitignored); the local admin
secret is the nhost default `nhost-admin-secret`. Production secrets are set via nhost /
Vercel env. The `llm_call` step will read `GROQ_API_KEY` from env (added in a later
milestone).

## Repo layout

- `nhost/` — Hasura migrations, metadata (schema + both permission layers), config
- `functions/` — serverless Action / Event / Cron handlers (added in later milestones)
- `web/` — Next.js frontend + `scripts/` (seed, verification)
- `ASSIGNMENT.md` — full spec · `CLAUDE.md` — durable rules · `ARCHITECTURE.md` — design log
