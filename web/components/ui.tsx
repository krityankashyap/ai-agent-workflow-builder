"use client";

import type { Role } from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-400/15 text-gray-500",
  running: "bg-blue-500/15 text-blue-600",
  paused: "bg-amber-500/15 text-amber-600",
  awaiting_approval: "bg-amber-500/15 text-amber-600",
  succeeded: "bg-green-500/15 text-green-600",
  failed: "bg-red-500/15 text-red-600",
  skipped: "bg-gray-400/15 text-gray-400 line-through",
};

export function RunStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
        STATUS_COLORS[status] ?? "bg-gray-400/15 text-gray-500"
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function StepStatusBadge({ status }: { status: string }) {
  return <RunStatusBadge status={status} />;
}

const ROLE_COLORS: Record<Role, string> = {
  owner: "bg-purple-500/15 text-purple-600",
  editor: "bg-blue-500/15 text-blue-600",
  viewer: "bg-gray-400/15 text-gray-500",
};

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_COLORS[role]}`}>
      {role}
    </span>
  );
}

export function QuotaBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const near = pct >= 80;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs opacity-70">
        <span>Run quota</span>
        <span>
          {used} / {limit}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
        <div
          className={`h-full rounded-full ${near ? "bg-red-500" : "bg-blue-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
