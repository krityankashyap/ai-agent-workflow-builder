"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { nhost } from "@/lib/nhost";
import {
  canEdit,
  createWorkflow,
  getMemberships,
  getWorkflows,
  type Membership,
  type WorkflowSummary,
} from "@/lib/api";
import { AuthForm } from "@/components/AuthForm";
import { QuotaBar, RoleBadge, RunStatusBadge } from "@/components/ui";

export default function Home() {
  const { session, isLoading, email } = useAuth();
  if (isLoading)
    return <div className="flex min-h-screen items-center justify-center">Loading…</div>;
  return session ? <Dashboard email={email} /> : <AuthForm />;
}

function Dashboard({ email }: { email: string | null }) {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = memberships?.find((m) => m.organization.id === orgId);

  useEffect(() => {
    getMemberships()
      .then((ms) => {
        setMemberships(ms);
        if (ms[0]) setOrgId(ms[0].organization.id);
      })
      .catch((e) => setError(e.message));
  }, []);

  const loadWorkflows = useCallback(async (oid: string) => {
    setWorkflows(null);
    try {
      setWorkflows(await getWorkflows(oid));
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    if (orgId) void loadWorkflows(orgId);
  }, [orgId, loadWorkflows]);

  async function onCreate() {
    if (!orgId || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createWorkflow(orgId, newName.trim());
      router.push(`/workflows/${id}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  async function signOut() {
    await nhost.auth.signOut({ refreshToken: nhost.getUserSession()?.refreshToken });
  }

  return (
    <div className="mx-auto w-full max-w-4xl p-6 sm:p-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Agent Workflow Builder</h1>
          <p className="text-sm opacity-60">{email}</p>
        </div>
        <button
          onClick={signOut}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          Sign out
        </button>
      </header>

      {error && (
        <p className="mb-4 rounded-md bg-red-500/10 p-3 text-sm text-red-600">{error}</p>
      )}

      {/* Org switcher */}
      {memberships && memberships.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {memberships.map((m) => (
            <button
              key={m.organization.id}
              onClick={() => setOrgId(m.organization.id)}
              className={`rounded-full border px-3 py-1 text-sm ${
                m.organization.id === orgId
                  ? "border-blue-600 bg-blue-600/10 text-blue-600"
                  : "border-black/15 dark:border-white/20"
              }`}
            >
              {m.organization.name}
            </button>
          ))}
        </div>
      )}

      {current && (
        <section className="mb-6 rounded-xl border border-black/10 p-4 dark:border-white/15">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium">{current.organization.name}</span>
              <RoleBadge role={current.role} />
            </div>
            <span className="text-xs opacity-50">plan: {current.organization.plan}</span>
          </div>
          <QuotaBar
            used={current.organization.quota_used}
            limit={current.organization.quota_limit}
          />
        </section>
      )}

      {/* Create workflow (editors/owners only) */}
      {current && canEdit(current.role) && (
        <div className="mb-6 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New workflow name…"
            className="flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-blue-500 dark:border-white/20"
          />
          <button
            onClick={onCreate}
            disabled={busy || !newName.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            Create
          </button>
        </div>
      )}

      {/* Workflow list */}
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide opacity-60">
        Workflows
      </h2>
      {workflows === null && <p className="opacity-70">Loading…</p>}
      {workflows?.length === 0 && <p className="opacity-70">No workflows yet.</p>}
      <ul className="space-y-2">
        {workflows?.map((w) => {
          const latest = w.runs[0];
          return (
            <li key={w.id}>
              <Link
                href={`/workflows/${w.id}`}
                className="flex items-center justify-between rounded-xl border border-black/10 p-4 hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
              >
                <div>
                  <div className="font-medium">{w.name}</div>
                  <div className="mt-1 text-xs opacity-60">
                    {w.steps.length} steps ·{" "}
                    {w.triggers.map((t) => t.type).join(", ") || "no triggers"}
                  </div>
                </div>
                {latest ? (
                  <RunStatusBadge status={latest.status} />
                ) : (
                  <span className="text-xs opacity-40">never run</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
