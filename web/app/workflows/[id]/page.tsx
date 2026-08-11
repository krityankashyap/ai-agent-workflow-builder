"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import {
  canRun,
  getMemberships,
  getWorkflow,
  triggerWorkflowRun,
  type Role,
  type WorkflowDetail,
} from "@/lib/api";
import { Builder } from "@/components/Builder";
import { RunView } from "@/components/RunView";
import { RunStatusBadge } from "@/components/ui";

export default function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { session, isLoading } = useAuth();
  const [wf, setWf] = useState<WorkflowDetail | null | undefined>(undefined);
  const [role, setRole] = useState<Role | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [w, ms] = await Promise.all([getWorkflow(id), getMemberships()]);
      setWf(w);
      setRole(w ? ms.find((m) => m.organization.id === w.org_id)?.role ?? null : null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    if (session) void reload();
  }, [session, reload]);

  if (isLoading) return <Center>Loading…</Center>;
  if (!session) return <Center>Please sign in.</Center>;
  if (wf === undefined) return <Center>Loading workflow…</Center>;
  // Isolation, visible in the UI: a non-member (e.g. an Org B user) who navigates
  // to this id gets nothing back from the permission-filtered query.
  if (wf === null)
    return (
      <Center>
        <div className="text-center">
          <p className="mb-2 font-medium">Workflow not found</p>
          <p className="mb-4 text-sm opacity-60">
            It doesn’t exist, or it belongs to an organization you’re not a member of.
          </p>
          <Link href="/" className="text-sm text-blue-600 hover:underline">
            ← Back
          </Link>
        </div>
      </Center>
    );

  async function onRun() {
    setRunning(true);
    setError(null);
    try {
      const r = await triggerWorkflowRun(id);
      setActiveRunId(r.triggerWorkflowRun.run_id);
      void reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6 sm:p-8">
      <div className="mb-4">
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          ← Workflows
        </Link>
      </div>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{wf.name}</h1>
          {wf.description && <p className="mt-1 text-sm opacity-60">{wf.description}</p>}
          <p className="mt-1 text-xs opacity-40">
            your role: {role ?? "—"}
          </p>
        </div>
        {/* Run button is hidden for viewers. */}
        {canRun(role) && (
          <button
            onClick={onRun}
            disabled={running}
            className="rounded-md bg-green-600 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {running ? "Starting…" : "▶ Run"}
          </button>
        )}
      </header>

      {error && (
        <p className="mb-4 rounded-md bg-red-500/10 p-3 text-sm text-red-600">{error}</p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Builder workflow={wf} role={role} onChanged={reload} />

        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide opacity-60">
            {activeRunId ? "Live run" : "Runs"}
          </h2>
          {activeRunId ? (
            <RunView
              runId={activeRunId}
              role={role}
              onClose={() => {
                setActiveRunId(null);
                void reload();
              }}
            />
          ) : (
            <ul className="space-y-2">
              {wf.runs.length === 0 && <li className="text-sm opacity-60">No runs yet.</li>}
              {wf.runs.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setActiveRunId(r.id)}
                    className="flex w-full items-center justify-between rounded-lg border border-black/10 p-3 text-left hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
                  >
                    <span className="text-xs opacity-60">
                      {r.trigger_type ?? "manual"} · {new Date(r.started_at).toLocaleTimeString()}
                    </span>
                    <RunStatusBadge status={r.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-6">{children}</div>;
}
