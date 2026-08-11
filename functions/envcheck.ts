// TEMPORARY diagnostic: reports which internal GraphQL URL a Function can reach
// on this environment (no secrets are returned — only booleans + URLs). Remove
// after deployment wiring is confirmed.
import type { Request, Response } from "express";

export default async (_req: Request, res: Response) => {
  const admin =
    process.env.HASURA_GRAPHQL_ADMIN_SECRET || process.env.NHOST_ADMIN_SECRET || "";
  const vars = {
    HASURA_GRAPHQL_GRAPHQL_URL: process.env.HASURA_GRAPHQL_GRAPHQL_URL ?? null,
    NHOST_GRAPHQL_URL: process.env.NHOST_GRAPHQL_URL ?? null,
    FUNCTIONS_INTERNAL_URL: process.env.FUNCTIONS_INTERNAL_URL ?? null,
    NHOST_FUNCTIONS_URL: process.env.NHOST_FUNCTIONS_URL ?? null,
    hasAdmin: !!admin,
    hasGroq: !!process.env.GROQ_API_KEY,
  };
  const candidates = [
    process.env.HASURA_GRAPHQL_GRAPHQL_URL,
    "http://graphql:8080/v1/graphql",
    process.env.NHOST_GRAPHQL_URL,
    process.env.NHOST_GRAPHQL_URL ? process.env.NHOST_GRAPHQL_URL + "/graphql" : null,
  ].filter((x): x is string => !!x);

  const tests: Record<string, string> = {};
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hasura-admin-secret": admin },
        body: JSON.stringify({ query: "{ __typename }" }),
      });
      tests[url] = `HTTP ${r.status} :: ${(await r.text()).slice(0, 80)}`;
    } catch (e: any) {
      tests[url] = `ERR ${e?.message} / cause: ${e?.cause?.message ?? e?.cause ?? ""}`;
    }
  }
  res.status(200).json({ vars, tests });
};
