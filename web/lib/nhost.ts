import { createClient } from "@nhost/nhost-js";

// Single browser-side Nhost client.
// For local CLI development the SDK targets the local stack when subdomain and
// region are both "local" (resolves to the *.local.nhost.run URLs on :443).
// In production these come from env (set in Vercel) and point at Nhost Cloud.
export const nhost = createClient({
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN ?? "local",
  region: process.env.NEXT_PUBLIC_NHOST_REGION ?? "local",
});
