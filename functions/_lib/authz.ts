// The trust boundary. Action handlers run with admin DB access, so they MUST
// authorize every call themselves using the Hasura-forwarded session variables
// (derived from the validated JWT — unforgeable). We NEVER trust the action
// input for identity or authority.
import { adminGql } from "./hasura";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Pull the caller's user id out of Hasura's forwarded session variables.
export function callerId(
  sessionVariables: Record<string, string> | undefined
): string {
  const id = sessionVariables?.["x-hasura-user-id"];
  if (!id) throw new HttpError(401, "Not authenticated");
  return id;
}

export interface Membership {
  org_id: string;
  role: "owner" | "editor" | "viewer";
}

// The caller's role in a specific org (null if not a member).
export async function getMembership(
  userId: string,
  orgId: string
): Promise<Membership | null> {
  const data = await adminGql<{ org_members: Membership[] }>(
    `query ($userId: uuid!, $orgId: uuid!) {
       org_members(
         where: { user_id: { _eq: $userId }, org_id: { _eq: $orgId } }
         limit: 1
       ) { org_id role }
     }`,
    { userId, orgId }
  );
  return data.org_members[0] ?? null;
}

// Load a workflow's org (admin) so the handler can authorize against it.
export async function getWorkflowOrg(workflowId: string): Promise<string | null> {
  const data = await adminGql<{ workflows_by_pk: { org_id: string } | null }>(
    `query ($id: uuid!) { workflows_by_pk(id: $id) { org_id } }`,
    { id: workflowId }
  );
  return data.workflows_by_pk?.org_id ?? null;
}
