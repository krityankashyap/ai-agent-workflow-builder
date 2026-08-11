"use client";

import { useEffect, useState } from "react";
import { createClient as createWsClient, type Client } from "graphql-ws";
import { nhost } from "./nhost";

// Query/mutation helper over the nhost SDK (which handles the auth header +
// background token refresh). Throws on GraphQL errors so callers can try/catch.
export async function run<T = any>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const r = await nhost.graphql.request<T>({ query, variables });
  if (r.body.errors?.length) {
    throw new Error(r.body.errors.map((e) => e.message).join("; "));
  }
  return r.body.data as T;
}

// Lazy singleton graphql-ws client (browser only). connectionParams reads the
// current access token at (re)connect time, so it self-heals across refreshes.
let wsClient: Client | null = null;
function getWsClient(): Client {
  if (!wsClient) {
    const wsUrl = nhost.graphql.url.replace(/^http/, "ws"); // wss://…/v1
    wsClient = createWsClient({
      url: wsUrl,
      connectionParams: () => {
        const token = nhost.getUserSession()?.accessToken;
        return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
      },
    });
  }
  return wsClient;
}

// Live subscription hook. Returns the latest payload; re-subscribes when the
// query/variables change or `enabled` flips. This is what makes runs update with
// no refresh — the step_runs subscription drives the run view.
export function useSubscription<T = any>(
  query: string,
  variables?: Record<string, unknown>,
  enabled = true
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const varsKey = JSON.stringify(variables ?? {});

  useEffect(() => {
    if (!enabled) return;
    setError(null);
    const unsub = getWsClient().subscribe<T>(
      { query, variables },
      {
        next: (msg) => {
          if (msg.data) setData(msg.data as T);
        },
        error: (e: any) =>
          setError(e?.message ?? e?.[0]?.message ?? "subscription error"),
        complete: () => {},
      }
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, varsKey, enabled]);

  return { data, error };
}
