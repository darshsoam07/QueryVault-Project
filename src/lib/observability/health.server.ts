/**
 * Dependency health probes with readiness/liveness semantics.
 *
 * Liveness  = "is this application process healthy?" — never depends on a
 *             third party, so a provider outage cannot trigger a restart loop.
 * Readiness = "can this instance serve traffic?" — critical dependencies must
 *             be reachable.
 *
 * Every result carries an explicit `kind`: `application` failures are our bug,
 * `dependency` failures are someone else's outage, `config` means the
 * environment is missing something. That distinction is the whole point.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { describeAiProvider, type AiProvider } from "@/lib/ai-gateway.server";

export type CheckState = "up" | "degraded" | "down" | "unknown";
export type FailureKind = "none" | "application" | "dependency" | "config";

export type CheckResult = {
  name: string;
  state: CheckState;
  kind: FailureKind;
  critical: boolean;
  latencyMs: number | null;
  detail: string;
};

const TIMEOUT_MS = 4000;

async function timed<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<{
  value: T | null;
  latencyMs: number;
  error: unknown;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const value = await fn(controller.signal);
    return { value, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    return { value: null, latencyMs: Date.now() - started, error };
  } finally {
    clearTimeout(timer);
  }
}

function ok(name: string, critical: boolean, latencyMs: number, detail: string): CheckResult {
  return { name, state: "up", kind: "none", critical, latencyMs, detail };
}

function down(
  name: string,
  critical: boolean,
  kind: FailureKind,
  latencyMs: number | null,
  detail: string,
): CheckResult {
  return { name, state: "down", kind, critical, latencyMs, detail };
}

/**
 * Which required Supabase variables are absent, if any.
 *
 * Every probe that talks to Supabase consults this first. Without it, an
 * unconfigured deployment reports its database and storage as `dependency`
 * failures — blaming a third party for our own missing environment, which is
 * exactly the distinction `kind` exists to make.
 */
function missingSupabaseConfig(): string | null {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (name) => !process.env[name],
  );
  // Names only. The values are secrets and this payload is served over HTTP.
  return missing.length > 0 ? `missing configuration: ${missing.join(", ")}` : null;
}

/** The app itself: config present, code paths importable. */
export async function checkApplication(): Promise<CheckResult> {
  const misconfigured = missingSupabaseConfig();
  if (misconfigured) return down("api", true, "config", 0, misconfigured);
  return ok("api", true, 0, "application responding");
}

/**
 * The database is reachable *and* the schema is applied.
 *
 * This asserts a positive result rather than the absence of an error, because
 * the absence of an error is not evidence of health here. The obvious cheap
 * form of this probe — `.select("id", { count: "exact", head: true })` — issues
 * a HEAD request, and the Supabase edge answers HEAD on a table that does not
 * exist with `204, no body`, so `error` is null and `count` is null. The
 * identical request as a GET returns `404 PGRST205`. A probe written the cheap
 * way therefore reports a completely unmigrated database as healthy, which is
 * the exact state in which it must not accept traffic.
 *
 * `documents` stands in for the schema as a whole: migrations apply as a unit,
 * so if the first user table is missing, nothing is there. Selecting only `id`
 * reads a uuid at most — never document content.
 */
export async function checkDatabase(): Promise<CheckResult> {
  const misconfigured = missingSupabaseConfig();
  if (misconfigured) return down("database", true, "config", 0, misconfigured);
  const { value, latencyMs, error } = await timed(async () => {
    const { data, error: queryError } = await supabaseAdmin.from("documents").select("id").limit(1);
    if (queryError) throw new Error(queryError.message);
    // An existing-but-empty table gives `[]`, which is healthy. Anything that
    // is not a row set means we never actually reached the table.
    if (!Array.isArray(data)) throw new Error("database returned no result set");
    return true;
  });
  if (!value) {
    return down("database", true, "dependency", latencyMs, describe(error, "database unreachable"));
  }
  return ok("database", true, latencyMs, "schema reachable");
}

/**
 * The bucket exists and is still private.
 *
 * Same failure mode as above: `storage.from(bucket).list()` returns
 * `{ data: [], error: null }` for a bucket that does not exist, so a probe
 * built on it can never fail. `getBucket` 404s instead — and returns the
 * bucket's `public` flag, which lets readiness enforce the one storage
 * property that is a security boundary rather than a preference. Every
 * uploaded document is private user data; a bucket flipped public exposes all
 * of it, and that is worth refusing traffic over.
 */
export async function checkStorage(): Promise<CheckResult> {
  const bucket = "documents";
  const misconfigured = missingSupabaseConfig();
  if (misconfigured) return down("storage", true, "config", 0, misconfigured);
  const { value, latencyMs, error } = await timed(async () => {
    const { data, error: bucketError } = await supabaseAdmin.storage.getBucket(bucket);
    if (bucketError) throw new Error(bucketError.message);
    if (!data) throw new Error(`bucket "${bucket}" not found`);
    return data;
  });
  if (!value) {
    return down("storage", true, "dependency", latencyMs, describe(error, "storage unreachable"));
  }
  // Reported as `config`, not `dependency`: nobody else's outage caused this,
  // and no amount of retrying fixes it.
  if (value.public) {
    return down("storage", true, "config", latencyMs, `bucket "${bucket}" is public`);
  }
  return ok("storage", true, latencyMs, `bucket "${bucket}" reachable and private`);
}

/** The SQL retrieval functions must exist and be callable. */
export async function checkRetrievalFunction(): Promise<CheckResult> {
  const misconfigured = missingSupabaseConfig();
  if (misconfigured) return down("retrieval_function", true, "config", 0, misconfigured);
  const { value, latencyMs, error } = await timed(async () => {
    // A null requesting user can never match rows, so this exercises the
    // function contract without reading anyone's data.
    const { error: rpcError } = await supabaseAdmin.rpc("lexical_document_chunks", {
      query_text: "healthcheck",
      requesting_user_id: "00000000-0000-0000-0000-000000000000",
      match_count: 1,
    });
    if (rpcError) throw new Error(rpcError.message);
    return true;
  });
  if (!value) {
    return down(
      "retrieval_function",
      true,
      "application",
      latencyMs,
      describe(error, "retrieval function failed"),
    );
  }
  return ok("retrieval_function", true, latencyMs, "callable");
}

async function checkGateway(
  name: string,
  critical: boolean,
  deep: boolean,
  probe: (provider: AiProvider, signal: AbortSignal) => Promise<void>,
): Promise<CheckResult> {
  const resolved = describeAiProvider();
  if (!resolved.configured) return down(name, critical, "config", 0, resolved.reason);
  const { provider } = resolved;
  if (!deep) {
    return {
      name,
      state: "unknown",
      kind: "none",
      critical,
      latencyMs: null,
      detail: `configured: ${provider.label} (shallow probe)`,
    };
  }
  const { value, latencyMs, error } = await timed(async (signal) => {
    await probe(provider, signal);
    return true;
  });
  if (!value) {
    return down(name, critical, "dependency", latencyMs, describe(error, "provider unreachable"));
  }
  return ok(name, critical, latencyMs, `${provider.label} responded`);
}

export function checkEmbeddingProvider(deep: boolean): Promise<CheckResult> {
  return checkGateway("embedding_provider", true, deep, async (provider, signal) => {
    const response = await fetch(`${provider.baseUrl}/embeddings`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", ...provider.authHeaders() },
      body: JSON.stringify({
        model: provider.embeddingModel,
        input: ["health"],
        ...(provider.supportsDimensionsParam ? { dimensions: provider.embeddingDimensions } : {}),
      }),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    await response.arrayBuffer();
  });
}

export function checkLlmProvider(deep: boolean): Promise<CheckResult> {
  return checkGateway("llm_provider", true, deep, async (provider, signal) => {
    const response = await fetch(`${provider.baseUrl}/models`, {
      signal,
      headers: { ...provider.authHeaders() },
    });
    if (!response.ok && response.status !== 404) throw new Error(`status ${response.status}`);
    await response.arrayBuffer();
  });
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "timed out";
    return error.message.slice(0, 160);
  }
  return fallback;
}

export type HealthReport = {
  status: "healthy" | "degraded" | "unhealthy";
  probe: "live" | "ready";
  failure: FailureKind;
  checks: CheckResult[];
  durationMs: number;
  version: string;
};

/** Runs the readiness set; `deep` also pings the AI providers. */
export async function runReadiness(deep: boolean): Promise<HealthReport> {
  const started = Date.now();
  const checks = await Promise.all([
    checkApplication(),
    checkDatabase(),
    checkStorage(),
    checkRetrievalFunction(),
    checkEmbeddingProvider(deep),
    checkLlmProvider(deep),
  ]);

  const failed = checks.filter((check) => check.state === "down");
  const criticalFailures = failed.filter((check) => check.critical);
  const appFailure = failed.find((c) => c.kind === "application" || c.kind === "config");

  return {
    status: criticalFailures.length > 0 ? "unhealthy" : failed.length > 0 ? "degraded" : "healthy",
    probe: "ready",
    failure: appFailure ? appFailure.kind : failed.length > 0 ? "dependency" : "none",
    checks,
    durationMs: Date.now() - started,
    version: process.env["QV_RELEASE"] ?? "dev",
  };
}

export async function runLiveness(): Promise<HealthReport> {
  const started = Date.now();
  const app = await checkApplication();
  return {
    status: app.state === "up" ? "healthy" : "unhealthy",
    probe: "live",
    failure: app.kind,
    checks: [app],
    durationMs: Date.now() - started,
    version: process.env["QV_RELEASE"] ?? "dev",
  };
}
