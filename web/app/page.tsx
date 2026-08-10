"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { nhost } from "@/lib/nhost";

// --- Types for the M0 dashboard query --------------------------------------

interface Membership {
  role: string;
  organization: {
    id: string;
    name: string;
    plan: string;
    quota_limit: number;
    quota_used: number;
  };
}

// The user only ever sees memberships for orgs they belong to, because the
// Hasura select permission on org_members scopes rows to X-Hasura-User-Id.
const MY_ORGS_QUERY = /* GraphQL */ `
  query MyOrgs {
    org_members {
      role
      organization {
        id
        name
        plan
        quota_limit
        quota_used
      }
    }
  }
`;

export default function Home() {
  const { session, isLoading, email } = useAuth();

  if (isLoading) {
    return <Centered>Loading…</Centered>;
  }

  return session ? <Dashboard email={email} /> : <AuthForm />;
}

// --- Auth form --------------------------------------------------------------

function AuthForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        await nhost.auth.signUpEmailPassword({ email, password });
      } else {
        await nhost.auth.signInEmailPassword({ email, password });
      }
      // On success the SDK persists the session and fires onChange, which the
      // AuthProvider listens to — the dashboard renders with no manual refresh.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Centered>
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-black/10 dark:border-white/15 p-6"
      >
        <h1 className="text-xl font-semibold">
          {mode === "signin" ? "Sign in" : "Create account"}
        </h1>
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 outline-none focus:border-blue-500"
        />
        <input
          type="password"
          required
          placeholder="Password (min 9 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 outline-none focus:border-blue-500"
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-blue-600 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? "…" : mode === "signin" ? "Sign in" : "Sign up"}
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="w-full text-sm text-blue-600 hover:underline"
        >
          {mode === "signin"
            ? "Need an account? Sign up"
            : "Have an account? Sign in"}
        </button>
      </form>
    </Centered>
  );
}

// --- Dashboard --------------------------------------------------------------

function Dashboard({ email }: { email: string | null }) {
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const resp = await nhost.graphql.request<{ org_members: Membership[] }>({
        query: MY_ORGS_QUERY,
      });
      if (resp.body.errors?.length) {
        setError(resp.body.errors.map((e) => e.message).join("; "));
        return;
      }
      setMemberships(resp.body.data?.org_members ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orgs");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut() {
    const refreshToken = nhost.getUserSession()?.refreshToken;
    await nhost.auth.signOut({ refreshToken });
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Agent Workflow Builder</h1>
          <p className="text-sm opacity-70">Signed in as {email}</p>
        </div>
        <button
          onClick={signOut}
          className="rounded-md border border-black/15 dark:border-white/20 px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
        >
          Sign out
        </button>
      </header>

      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide opacity-60">
        Your organizations
      </h2>

      {error && (
        <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-600">
          {error}
        </p>
      )}

      {!error && memberships === null && <p className="opacity-70">Loading…</p>}

      {memberships?.length === 0 && (
        <p className="opacity-70">
          You are not a member of any organization yet.
        </p>
      )}

      <ul className="space-y-3">
        {memberships?.map((m) => (
          <li
            key={m.organization.id}
            className="rounded-xl border border-black/10 dark:border-white/15 p-4"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{m.organization.name}</span>
              <span className="rounded-full bg-blue-600/10 px-2.5 py-0.5 text-xs font-medium text-blue-600">
                {m.role}
              </span>
            </div>
            <p className="mt-1 text-sm opacity-70">
              Plan: {m.organization.plan} · Quota: {m.organization.quota_used}/
              {m.organization.quota_limit}
            </p>
            <p className="mt-1 font-mono text-xs opacity-40">
              {m.organization.id}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Layout helper ----------------------------------------------------------

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      {children}
    </div>
  );
}
