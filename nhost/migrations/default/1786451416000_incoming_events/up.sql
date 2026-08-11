-- M6: a watched table for the database_event trigger. An INSERT here fires a
-- Hasura Event Trigger (functions/onDbEvent.ts), which starts a run for every
-- workflow in that org with an enabled `database_event` trigger.
CREATE TABLE public.incoming_events (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_incoming_events_org_id ON public.incoming_events (org_id);
