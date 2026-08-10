// Admin GraphQL client used by the execution engine.
//
// Talks to Hasura over the INTERNAL cluster URL with the admin secret, so it
// bypasses row permissions on purpose — the handlers are the trust boundary and
// authorize callers themselves (see authz.ts). Never expose this to the browser.
const GRAPHQL_URL =
  process.env.HASURA_GRAPHQL_GRAPHQL_URL || "http://graphql:8080/v1/graphql";
const ADMIN_SECRET =
  process.env.HASURA_GRAPHQL_ADMIN_SECRET || process.env.NHOST_ADMIN_SECRET || "";

export async function adminGql<T = any>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e: any) => e.message).join("; "));
  }
  return json.data as T;
}
