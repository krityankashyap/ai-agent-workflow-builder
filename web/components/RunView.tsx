"use client";

import { useState } from "react";
import { useSubscription } from "@/lib/graphql";
import {
  approveStep,
  canRun,
  RUN_SUBSCRIPTION,
  STEP_RUNS_SUBSCRIPTION,
  type Role,
  type StepRun,
} from "@/lib/api";
import { RunStatusBadge, StepStatusBadge } from "./ui";

function preview(sr: StepRun): string | null {
  if (sr.error) return sr.error;
  const o = sr.output;
  if (!o) return null;
  if (typeof o.text === "string") return o.text;
  if ("condition" in o) return `condition = ${o.condition}`;
  if ("status" in o) return `HTTP ${o.status}`;
  if ("note" in o) return o.note;
  return JSON.stringify(o).slice(0, 160);
}

export function RunView({
  runId,
  role,
  onClose,
}: {
  runId: string;
  role: Role | null;
  onClose: () => void;
}) {
  // (d) Live per-step progress + live run status — no refresh.
  const { data: stepsData } = useSubscription<{ step_runs: StepRun[] }>(
    STEP_RUNS_SUBSCRIPTION,
    { runId }
  );
  const { data: runData } = useSubscription<{
    workflow_runs_by_pk: { status: string; trigger_type: string | null } | null;
  }>(RUN_SUBSCRIPTION, { runId });

  const [approving, setApproving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const steps = stepsData?.step_runs ?? [];
  const runStatus = runData?.workflow_runs_by_pk?.status ?? "running";

  async function onApprove(stepRunId: string) {
    setApproving(stepRunId);
    setError(null);
    try {
      await approveStep(stepRunId);
      // The subscription streams the resume automatically — no manual refresh.
    } catch (e: any) {
      setError(e.message);
    } finally {
      setApproving(null);
    }
  }

  return (
    <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Run</span>
          <RunStatusBadge status={runStatus} />
        </div>
        <button onClick={onClose} className="text-xs text-blue-600 hover:underline">
          ← back to runs
        </button>
      </div>

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <ol className="space-y-2">
        {steps.map((sr) => {
          const p = preview(sr);
          const gateOpen = sr.status === "awaiting_approval";
          return (
            <li
              key={sr.id}
              className={`rounded-lg border p-3 ${
                gateOpen
                  ? "border-amber-500/40 bg-amber-500/5"
                  : "border-black/10 dark:border-white/15"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs opacity-40">{sr.position + 1}</span>
                  <span className="text-sm font-medium">{sr.step_type}</span>
                  {sr.attempt > 1 && (
                    <span className="text-xs opacity-50">· {sr.attempt} attempts</span>
                  )}
                </div>
                <StepStatusBadge status={sr.status} />
              </div>

              {p && (
                <p
                  className={`mt-1.5 whitespace-pre-wrap break-words text-xs ${
                    sr.error ? "text-red-600" : "opacity-70"
                  }`}
                >
                  {p.length > 240 ? p.slice(0, 240) + "…" : p}
                </p>
              )}

              {/* Pause/approve UI — only owner/editor sees the button. */}
              {gateOpen && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-amber-600">Paused — awaiting approval</span>
                  {canRun(role) && (
                    <button
                      onClick={() => onApprove(sr.id)}
                      disabled={approving === sr.id}
                      className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {approving === sr.id ? "Approving…" : "Approve"}
                    </button>
                  )}
                </div>
              )}

              {sr.approved_at && (
                <p className="mt-1 text-[11px] opacity-40">
                  approved {new Date(sr.approved_at).toLocaleTimeString()}
                </p>
              )}
            </li>
          );
        })}
        {steps.length === 0 && <li className="text-sm opacity-60">Starting…</li>}
      </ol>
    </div>
  );
}
