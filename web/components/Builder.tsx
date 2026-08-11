"use client";

import { useMemo, useState } from "react";
import { nhost } from "@/lib/nhost";
import {
  addTrigger,
  canEdit,
  deleteWorkflow,
  isOwner,
  OWNER_ONLY_STEP_TYPES,
  removeTrigger,
  saveSteps,
  STEP_TYPES,
  TRIGGER_TYPES,
  updateWorkflowMeta,
  type Role,
  type StepType,
  type TriggerType,
  type WorkflowDetail,
} from "@/lib/api";
import { useRouter } from "next/navigation";

interface EditStep {
  type: StepType;
  configText: string;
}

const CONFIG_TEMPLATES: Record<StepType, string> = {
  llm_call: JSON.stringify({ system: "", prompt: "Classify: {{prev.text}}" }, null, 2),
  http_request: JSON.stringify({ url: "https://api.github.com/zen", method: "GET" }, null, 2),
  conditional_branch: JSON.stringify(
    { left: "{{prev.text}}", operator: "contains", right: "URGENT", if_false: "skip_next" },
    null,
    2
  ),
  approval_gate: "{}",
  db_write: JSON.stringify({ note: "stub until M6" }, null, 2),
  notify: JSON.stringify({ note: "stub until M6" }, null, 2),
};

export function Builder({
  workflow,
  role,
  onChanged,
}: {
  workflow: WorkflowDetail;
  role: Role | null;
  onChanged: () => void;
}) {
  const router = useRouter();
  const editable = canEdit(role);
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? "");
  const [steps, setSteps] = useState<EditStep[]>(
    workflow.steps.map((s) => ({ type: s.type, configText: JSON.stringify(s.config ?? {}, null, 2) }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const fnWebhookUrl = useMemo(
    () => nhost.graphql.url.replace(".graphql.", ".functions.") + "/webhook",
    []
  );
  const [newTrigger, setNewTrigger] = useState<TriggerType>("manual");
  const [createdSecret, setCreatedSecret] = useState<{ id: string; secret: string } | null>(null);

  function update(i: number, patch: Partial<EditStep>) {
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));
  }
  function move(i: number, dir: -1 | 1) {
    setSteps((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }
  function addStep() {
    setSteps((s) => [...s, { type: "llm_call", configText: CONFIG_TEMPLATES.llm_call }]);
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      const parsed = steps.map((s, i) => {
        let config: any;
        try {
          config = s.configText.trim() ? JSON.parse(s.configText) : {};
        } catch {
          throw new Error(`Step ${i + 1} (${s.type}): config is not valid JSON`);
        }
        return { position: i, type: s.type, config };
      });
      await updateWorkflowMeta(workflow.id, name, description);
      await saveSteps(workflow.id, parsed);
      setOk(true);
      onChanged();
    } catch (e: any) {
      // Layer-2 rejections (e.g. an editor saving a db_write step) surface here.
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function onAddTrigger() {
    setError(null);
    setCreatedSecret(null);
    try {
      if (newTrigger === "webhook") {
        const secret = "whsec_" + crypto.randomUUID().replace(/-/g, "");
        await addTrigger(workflow.id, "webhook", secret);
        onChanged();
        // Re-read to show the newly created trigger's id alongside its secret.
        setTimeout(async () => {
          const { getWorkflow } = await import("@/lib/api");
          const w = await getWorkflow(workflow.id);
          const t = w?.triggers.find((x) => x.type === "webhook");
          if (t) setCreatedSecret({ id: t.id, secret });
        }, 150);
      } else {
        await addTrigger(workflow.id, newTrigger);
        onChanged();
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide opacity-60">Builder</h2>

      <div className="mb-4 space-y-2">
        <input
          value={name}
          disabled={!editable}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:opacity-60 dark:border-white/20"
        />
        <input
          value={description}
          disabled={!editable}
          placeholder="Description"
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:opacity-60 dark:border-white/20"
        />
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {steps.map((s, i) => {
          const ownerOnly = OWNER_ONLY_STEP_TYPES.includes(s.type) && !isOwner(role);
          return (
            <div key={i} className="rounded-lg border border-black/10 p-3 dark:border-white/15">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-mono opacity-40">{i + 1}</span>
                <select
                  value={s.type}
                  disabled={!editable}
                  onChange={(e) => update(i, { type: e.target.value as StepType })}
                  className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
                >
                  {STEP_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {ownerOnly && (
                  <span className="text-xs text-amber-600">owner-only type</span>
                )}
                {editable && (
                  <div className="ml-auto flex gap-1 text-xs">
                    <button onClick={() => move(i, -1)} className="rounded px-1.5 py-0.5 hover:bg-black/10 dark:hover:bg-white/10">↑</button>
                    <button onClick={() => move(i, 1)} className="rounded px-1.5 py-0.5 hover:bg-black/10 dark:hover:bg-white/10">↓</button>
                    <button
                      onClick={() => setSteps((st) => st.filter((_, idx) => idx !== i))}
                      className="rounded px-1.5 py-0.5 text-red-600 hover:bg-red-500/10"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
              <textarea
                value={s.configText}
                disabled={!editable}
                onChange={(e) => update(i, { configText: e.target.value })}
                spellCheck={false}
                rows={s.type === "approval_gate" ? 1 : 4}
                className="w-full rounded-md border border-black/10 bg-black/5 px-2 py-1.5 font-mono text-xs outline-none focus:border-blue-500 disabled:opacity-60 dark:border-white/15 dark:bg-white/5"
              />
            </div>
          );
        })}
      </div>

      {editable && (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={addStep}
            className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            + Add step
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save steps"}
          </button>
          {ok && <span className="text-xs text-green-600">saved ✓</span>}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {/* Triggers */}
      <div className="mt-6">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide opacity-50">Triggers</h3>
        <ul className="space-y-1">
          {workflow.triggers.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between rounded-md border border-black/10 px-3 py-1.5 text-sm dark:border-white/15"
            >
              <span>{t.type}</span>
              {editable && (
                <button
                  onClick={async () => {
                    await removeTrigger(t.id);
                    onChanged();
                  }}
                  className="text-xs text-red-600 hover:underline"
                >
                  remove
                </button>
              )}
            </li>
          ))}
          {workflow.triggers.length === 0 && (
            <li className="text-xs opacity-50">No triggers.</li>
          )}
        </ul>

        {editable && (
          <div className="mt-2 flex items-center gap-2">
            <select
              value={newTrigger}
              onChange={(e) => setNewTrigger(e.target.value as TriggerType)}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            >
              {TRIGGER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                  {t === "webhook" ? " (owner only)" : ""}
                </option>
              ))}
            </select>
            <button
              onClick={onAddTrigger}
              className="rounded-md border border-black/15 px-3 py-1 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
            >
              + Add trigger
            </button>
          </div>
        )}

        {createdSecret && (
          <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
            <p className="mb-1 font-medium text-amber-700 dark:text-amber-400">
              Webhook created — copy the secret now (shown once):
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all">
{`POST ${fnWebhookUrl}
{ "trigger_id": "${createdSecret.id}", "secret": "${createdSecret.secret}" }`}
            </pre>
          </div>
        )}
      </div>

      {isOwner(role) && (
        <button
          onClick={async () => {
            await deleteWorkflow(workflow.id);
            router.push("/");
          }}
          className="mt-6 text-xs text-red-600 hover:underline"
        >
          Delete workflow
        </button>
      )}
    </div>
  );
}
