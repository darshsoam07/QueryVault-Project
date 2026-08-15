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
import { EMBEDDING_MODEL, GATEWAY_BASE_URL } from "@/lib/ai-gateway.server";

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

/** The app itself: config present, code paths importable. */
export async function checkApplication(): Promise<CheckResult> {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    return down("api", true, "config", 0, `missing configuration: ${missing.join(", ")}`);
  }
  return ok("api", true, 0, "application responding");
}

export async function checkDatabase(): Promise<CheckResult> {
  const { value, latencyMs, error } = await timed(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: queryError } = await supabaseAdmin
      .from("documents")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (queryError) throw new Error(queryError.message);
    return true;
  });
  if (!value) {
    return down("database", true, "dependency", latencyMs, describe(error, "database unreachable"));
  }
  return ok("database", true, latencyMs, "query succeeded");
}

export async function checkStorage(): Promise<CheckResult> {
  const { value, latencyMs, error } = await timed(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: listError } = await supabaseAdmin.storage.from("documents").list("", {
      limit: 1,
    });
    if (listError) throw new Error(listError.message);
    return true;
  });
  if (!value) {
    return down("storage", true, "dependency", latencyMs, describe(error, "storage unreachable"));
  }
  return ok("storage", true, latencyMs, "bucket reachable");
}

/** The SQL retrieval functions must exist and be callable. */
export async function checkRetrievalFunction(): Promise<CheckResult> {
  const { value, latencyMs, error } = await timed(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
  probe: (apiKey: string, signal: AbortSignal) => Promise<void>,
): Promise<CheckResult> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return down(name, critical, "config", 0, "AI key not configured");
  if (!deep) {
    return { name, state: "unknown", kind: "none", critical, latencyMs: null, detail: "configured (shallow probe)" };
  }
  const { value, latencyMs, error } = await timed(async (signal) => {
    await probe(apiKey, signal);
    return true;
  });
  if (!value) {
    return down(name, critical, "dependency", latencyMs, describe(error, "provider unreachable"));
  }
  return ok(name, critical, latencyMs, "provider responded");
}

export function checkEmbeddingProvider(deep: boolean): Promise<CheckResult> {
  return checkGateway("embedding_provider", true, deep, async (apiKey, signal) => {
    const response = await fetch(`${GATEWAY_BASE_URL}/embeddings`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: ["health"] }),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    await response.arrayBuffer();
  });
}

export function checkLlmProvider(deep: boolean): Promise<CheckResult> {
  return checkGateway("llm_provider", true, deep, async (apiKey, signal) => {
    const response = await fetch(`${GATEWAY_BASE_URL}/models`, {
      signal,
      headers: { "Lovable-API-Key": apiKey },
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
    status:
      criticalFailures.length > 0 ? "unhealthy" : failed.length > 0 ? "degraded" : "healthy",
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
