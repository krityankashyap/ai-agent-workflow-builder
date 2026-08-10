// Step executors + helpers used by the engine (runFrom).
//
// A `Context` carries prior step outputs so later steps can reference them via
// {{ templates }} — e.g. an http_request URL or a conditional_branch can read
// the llm_call's text with "{{ prev.text }}" or "{{ steps.0.text }}".

export type Context = { steps: Record<number, any>; prev: any };

// Replace {{ path }} tokens inside strings; recurse into objects/arrays.
export function resolveTemplates(value: any, ctx: Context): any {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, path) => {
      const v = getPath(ctx, path);
      if (v == null) return "";
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[k] = resolveTemplates(value[k], ctx);
    return out;
  }
  return value;
}

function getPath(obj: any, path: string): any {
  return path
    .split(/[.[\]]+/)
    .filter(Boolean)
    .reduce((o, k) => (o == null ? o : o[k]), obj);
}

// Run `fn` up to `attempts` times (>=1 retry by default). On success returns the
// result and how many attempts it took; on total failure throws the last error
// with `.attempts` attached so the engine can record it on the step_run.
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 2
): Promise<{ result: T; attempts: number }> {
  let lastErr: any;
  for (let a = 1; a <= attempts; a++) {
    try {
      return { result: await fn(), attempts: a };
    } catch (e) {
      lastErr = e;
    }
  }
  const err = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  (err as any).attempts = attempts;
  throw err;
}

// --- llm_call: real Groq API call ------------------------------------------
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

export async function runLlmCall(config: any, ctx: Context): Promise<any> {
  const c = resolveTemplates(config ?? {}, ctx);
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not configured");
  const messages: any[] = [];
  if (c.system) messages.push({ role: "system", content: String(c.system) });
  messages.push({ role: "user", content: String(c.prompt ?? "") });

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: c.model ?? DEFAULT_MODEL,
      messages,
      temperature: c.temperature ?? 0.2,
      max_tokens: c.max_tokens ?? 512,
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json: any = await res.json();
  return { text: json.choices?.[0]?.message?.content ?? "", model: c.model ?? DEFAULT_MODEL };
}

// --- http_request: generic external call -----------------------------------
export async function runHttpRequest(config: any, ctx: Context): Promise<any> {
  const c = resolveTemplates(config ?? {}, ctx);
  // Test-only hook to deterministically exercise the retry path.
  if (c._test_fail) throw new Error("forced test failure (_test_fail)");
  const method = String(c.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && c.body != null;
  const res = await fetch(String(c.url), {
    method,
    headers: c.headers ?? {},
    body: hasBody ? (typeof c.body === "string" ? c.body : JSON.stringify(c.body)) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${c.url}`);
  return { status: res.status, body };
}

// --- conditional_branch: if/else on a prior step's output ------------------
export function runConditionalBranch(config: any, ctx: Context): any {
  const left = String(resolveTemplates(config?.left ?? "", ctx));
  const operator = config?.operator ?? "contains";
  const right = config?.right ?? "";
  const condition = evalOp(left, operator, right);
  // if_false controls the branch: skip the next step, or stop the run early.
  return { condition, left, operator, right, if_false: config?.if_false ?? "skip_next" };
}

function evalOp(left: string, op: string, right: any): boolean {
  const r = String(right);
  switch (op) {
    case "contains":
      return left.toLowerCase().includes(r.toLowerCase());
    case "not_contains":
      return !left.toLowerCase().includes(r.toLowerCase());
    case "equals":
      return left === r;
    case "not_equals":
      return left !== r;
    case "gt":
      return parseFloat(left) > parseFloat(r);
    case "lt":
      return parseFloat(left) < parseFloat(r);
    default:
      return false;
  }
}
