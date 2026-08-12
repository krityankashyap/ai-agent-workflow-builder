"use client";

import { useState } from "react";
import { nhost } from "@/lib/nhost";

// Seeded demo accounts (all share the same password). Surfaced on the sign-in
// screen so a reviewer with only the live URL can log in without the README.
const DEMO_PASSWORD = "password123";
const DEMO_ACCOUNTS = [
  { email: "owner-a@example.com", label: "Acme (Org A) · owner" },
  { email: "editor-a@example.com", label: "Acme (Org A) · editor" },
  { email: "viewer-a@example.com", label: "Acme (Org A) · viewer" },
  { email: "owner-b@example.com", label: "Globex (Org B) · owner" },
];

export function AuthForm() {
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
    <div className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-black/10 p-6 dark:border-white/15"
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
          className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-blue-500 dark:border-white/20"
        />
        <input
          type="password"
          required
          placeholder="Password (min 9 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-blue-500 dark:border-white/20"
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
          {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>

        {mode === "signin" && (
          <div className="border-t border-black/10 pt-4 dark:border-white/15">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide opacity-60">
              Demo accounts — click to fill (password {DEMO_PASSWORD})
            </p>
            <div className="space-y-1.5">
              {DEMO_ACCOUNTS.map((a) => (
                <button
                  key={a.email}
                  type="button"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword(DEMO_PASSWORD);
                    setError(null);
                  }}
                  className="flex w-full items-center justify-between rounded-md border border-black/10 px-3 py-1.5 text-left text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                >
                  <span className="font-mono">{a.email}</span>
                  <span className="text-xs opacity-60">{a.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
