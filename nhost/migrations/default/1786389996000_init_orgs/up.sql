-- M0 schema: organizations + org_members.
-- These two tables are the root of the whole permission model: every other
-- table (workflows, runs, ...) will scope to the caller via org_members.
-- Postgres 14 ships gen_random_uuid() in core, so no pgcrypto extension needed.

CREATE TABLE public.organizations (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text        NOT NULL,
    plan                text        NOT NULL DEFAULT 'free',
    -- Usage quota: how many workflow runs this org may execute per period.
    quota_limit         integer     NOT NULL DEFAULT 100,
    quota_used          integer     NOT NULL DEFAULT 0,
    quota_period_start  timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- org_members links an auth user to an org WITH a role. A single user can be
-- 'owner' in one org and 'viewer' in another at the same time -- which is why
-- roles live here (relational) and NOT as global Hasura roles.
CREATE TABLE public.org_members (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role        text        NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, user_id)
);

-- Fast lookups by the session user id (used by every permission filter).
CREATE INDEX idx_org_members_user_id ON public.org_members (user_id);
CREATE INDEX idx_org_members_org_id  ON public.org_members (org_id);
