-- M6: targets for the db_write and notify step types.
--   db_write  -> inserts a row into workflow_outputs
--   notify    -> inserts a row into notifications, whose INSERT fires a Hasura
--                Event Trigger that delivers it (functions/notify.ts)

CREATE TABLE public.workflow_outputs (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    workflow_id uuid        REFERENCES public.workflows(id) ON DELETE SET NULL,
    run_id      uuid        REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
    data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflow_outputs_org_id ON public.workflow_outputs (org_id);

CREATE TABLE public.notifications (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    run_id       uuid        REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
    channel      text        NOT NULL DEFAULT 'log',
    message      text        NOT NULL,
    -- 'pending' on insert; the Event Trigger handler flips it to 'delivered'.
    status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    delivered_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_org_id ON public.notifications (org_id);
