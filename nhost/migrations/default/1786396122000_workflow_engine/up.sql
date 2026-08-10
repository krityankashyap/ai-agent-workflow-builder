-- M1 schema: the workflow engine core.
-- organizations -> workflows -> (workflow_steps | workflow_triggers)
-- workflows -> workflow_runs -> step_runs
--
-- Status/type domains are enforced with CHECK constraints (single source of
-- truth, mirrored in ARCHITECTURE.md). org_id is denormalized onto
-- workflow_runs so run/step_run permission filters are one hop shorter.

-- ---------------------------------------------------------------------------
-- workflows
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflows (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name        text        NOT NULL,
    description text,
    -- Set by the DB (insert preset) to the creating user; never trusted from input.
    created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflows_org_id ON public.workflows (org_id);

-- ---------------------------------------------------------------------------
-- workflow_steps (ordered, typed, JSONB config)
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflow_steps (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid        NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
    position    integer     NOT NULL,          -- execution order within the workflow
    type        text        NOT NULL CHECK (type IN (
                    'llm_call', 'http_request', 'db_write',
                    'notify', 'conditional_branch', 'approval_gate')),
    config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflow_steps_workflow_id ON public.workflow_steps (workflow_id, position);

-- ---------------------------------------------------------------------------
-- workflow_triggers (how a run can be started)
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflow_triggers (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid        NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
    type        text        NOT NULL CHECK (type IN (
                    'manual', 'webhook', 'scheduled', 'database_event')),
    config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Shared secret for inbound webhook triggers (opaque token the caller must present).
    secret      text,
    enabled     boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflow_triggers_workflow_id ON public.workflow_triggers (workflow_id);

-- ---------------------------------------------------------------------------
-- workflow_runs (one per execution; must support a paused state)
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflow_runs (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id  uuid        NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
    -- Denormalized org for cheap, one-hop permission scoping of runs/step_runs.
    org_id       uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    status       text        NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'running', 'paused', 'succeeded', 'failed')),
    -- Index of the next step to execute; runFrom() resumes here after an approval.
    resume_index integer     NOT NULL DEFAULT 0,
    trigger_type text        CHECK (trigger_type IN (
                    'manual', 'webhook', 'scheduled', 'database_event')),
    triggered_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
    error        text,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);
CREATE INDEX idx_workflow_runs_workflow_id ON public.workflow_runs (workflow_id);
CREATE INDEX idx_workflow_runs_org_id ON public.workflow_runs (org_id);

-- ---------------------------------------------------------------------------
-- step_runs (one per step per run; subscription target)
-- ---------------------------------------------------------------------------
CREATE TABLE public.step_runs (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      uuid        NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
    -- Keep the run's history even if the step definition is later deleted.
    step_id     uuid        REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
    position    integer     NOT NULL,   -- snapshot of the step order at run time
    step_type   text        NOT NULL,   -- snapshot of the step type at run time
    status      text        NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'running', 'awaiting_approval',
                    'succeeded', 'failed', 'skipped')),
    input       jsonb,
    output      jsonb,
    error       text,
    attempt     integer     NOT NULL DEFAULT 0,
    approved_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at timestamptz,
    started_at  timestamptz,
    finished_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_step_runs_run_id ON public.step_runs (run_id, position);

-- ---------------------------------------------------------------------------
-- Aggregation: average run duration + run counts per workflow.
-- Exposed as a Postgres VIEW and tracked in Hasura (scoped by org via a manual
-- relationship). org_id is carried through so the same membership filter applies.
-- ---------------------------------------------------------------------------
CREATE VIEW public.workflow_run_stats AS
SELECT
    w.id      AS workflow_id,
    w.org_id  AS org_id,
    count(r.id)                                             AS total_runs,
    count(r.id) FILTER (WHERE r.status = 'succeeded')       AS succeeded_runs,
    count(r.id) FILTER (WHERE r.status = 'failed')          AS failed_runs,
    count(r.id) FILTER (WHERE r.status = 'paused')          AS paused_runs,
    avg(EXTRACT(EPOCH FROM (r.finished_at - r.started_at)))
        FILTER (WHERE r.finished_at IS NOT NULL)            AS avg_duration_seconds
FROM public.workflows w
LEFT JOIN public.workflow_runs r ON r.workflow_id = w.id
GROUP BY w.id, w.org_id;
