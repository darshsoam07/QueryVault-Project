/**
 * Boot-time configuration validation.
 *
 * Imported for its side effect by the server entry (`src/server.ts`) so it runs
 * once, before the first request. A process that boots with unusable Supabase
 * configuration cannot serve a single request successfully; it fails every one
 * with `401 Invalid API key`, which reads as an authentication bug and sends
 * whoever is debugging it into the auth code rather than the environment. So the
 * process refuses to start instead, naming exactly what is wrong.
 *
 * The startup line also prints the resolved project ref. That single non-secret
 * fact is what distinguishes "the key is wrong" from "the key is for a different
 * project", and it is invisible otherwise.
 *
 * SECURITY: only variable names and derived non-secret facts are logged. No
 * value from the environment is ever printed, including truncated or hashed.
 */
import {
  formatFindings,
  hasFatalFinding,
  projectRefFromUrl,
  validateSupabaseConfig,
  type ConfigFinding,
} from "./validate";

/** Codes that describe disagreement between values rather than a missing one. */
const MISMATCH_CODES = new Set([
  "CONFIG_PROJECT_MISMATCH",
  "CONFIG_MIRROR_MISMATCH",
  "CONFIG_SECRET_IN_PUBLIC",
]);

/**
 * Dedup key for the second validation pass.
 *
 * A project mismatch is deduped by code alone: the public pass re-reports the
 * same disagreement with more variable names attached, and two findings that
 * describe one fault make the actionable one harder to see. Mirror mismatches
 * keep their variables in the key, because each pair is a separate fault.
 */
function dedupKey(finding: ConfigFinding): string {
  return finding.code === "CONFIG_PROJECT_MISMATCH"
    ? finding.code
    : `${finding.code}:${finding.variables.join(",")}`;
}

function readEnv(): Record<string, string | undefined> {
  const names = [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_PROJECT_ID",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_PROJECT_ID",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENAI_API_KEY",
    "LOVABLE_API_KEY",
    "AI_API_KEY",
    "INGESTION_WORKER_SECRET",
    "QV_RELEASE",
  ];
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

/**
 * Findings for the running process.
 *
 * The server tier is required. The public tier is deliberately *not*: `VITE_*`
 * values are inlined at build time, so a correctly-built container has no reason
 * to carry them at runtime and demanding them would fail a healthy deployment.
 * They are still cross-checked when present, because a runtime `VITE_*` that
 * disagrees with the server tier means SSR and the browser target different
 * projects — a real fault worth reporting.
 */
export function collectBootFindings(
  env: Record<string, string | undefined> = readEnv(),
): ConfigFinding[] {
  const findings = validateSupabaseConfig(env, ["server"]);

  const publicPresent = [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_PROJECT_ID",
  ].some((name) => (env[name] ?? "").trim().length > 0);

  if (publicPresent) {
    const seen = new Set(findings.map(dedupKey));
    for (const finding of validateSupabaseConfig(env, ["public", "server"])) {
      if (!MISMATCH_CODES.has(finding.code)) continue;
      const key = dedupKey(finding);
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(finding);
    }
  }

  // Not fatal by design: the AI boundary already fails closed with a structured
  // NOT_CONFIGURED, and the readiness probe reports it as a `config` fault. A
  // server that can still serve auth, uploads and the UI should boot.
  const aiKeySet = ["OPENAI_API_KEY", "LOVABLE_API_KEY", "AI_API_KEY"].some(
    (name) => (env[name] ?? "").trim().length > 0,
  );
  if (!aiKeySet) {
    findings.push({
      severity: "warning",
      code: "CONFIG_MISSING",
      variables: ["OPENAI_API_KEY"],
      message:
        "No AI provider key is set (OPENAI_API_KEY / LOVABLE_API_KEY / AI_API_KEY). " +
        "Ingestion will fail at the embedding step and /api/chat will return NOT_CONFIGURED.",
    });
  }

  if (!(env["INGESTION_WORKER_SECRET"] ?? "").trim()) {
    findings.push({
      severity: "warning",
      code: "CONFIG_MISSING",
      variables: ["INGESTION_WORKER_SECRET"],
      message:
        "INGESTION_WORKER_SECRET is not set. The external worker-drain trigger and the " +
        "deep health probe fall back to worker_credentials and stay fail-closed.",
    });
  }

  return findings;
}

/**
 * Validates and reports. Throws on any fatal finding, which in the Nitro entry
 * aborts startup — the intended outcome for a deployment that cannot work.
 */
export function assertBootConfig(
  env: Record<string, string | undefined> = readEnv(),
): ConfigFinding[] {
  const findings = collectBootFindings(env);
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const errors = findings.filter((finding) => finding.severity === "error");

  if (warnings.length > 0) {
    console.warn(`[config] ${warnings.length} warning(s):\n${formatFindings(warnings)}`);
  }

  if (hasFatalFinding(findings)) {
    const message =
      `Refusing to start: ${errors.length} fatal configuration error(s).\n` +
      `${formatFindings(errors)}\n` +
      "  See .env.example and docs/DEPLOYMENT.md for the required contract.";
    console.error(`[config] ${message}`);
    throw new Error(message);
  }

  const ref = projectRefFromUrl(env["SUPABASE_URL"]) ?? env["SUPABASE_PROJECT_ID"] ?? "unknown";
  console.info(`[config] ok — supabase project ${ref}, release ${env["QV_RELEASE"] ?? "dev"}`);
  return findings;
}

/**
 * Process-wide memo key.
 *
 * Deliberately on `globalThis` rather than in module scope. Nitro builds the
 * startup-plugin graph and the SSR service graph separately, so this module is
 * emitted into both chunks and each copy would have its own module state — which
 * is exactly what happened: a healthy server logged its startup line twice, once
 * at boot and once on the first request.
 */
export const BOOT_CHECK_FLAG = "__queryvault_boot_config_checked__";

/**
 * Runs `assertBootConfig` exactly once per process, from whichever entry point
 * reaches it first.
 *
 * There are two, because the Nitro output splits: the startup plugin runs before
 * the listener accepts connections, while the SSR entry chunk is imported lazily
 * on the first request. The plugin is the one that matters — a container whose
 * configuration cannot serve a request must not stay up passing health checks —
 * and the SSR call is the backstop for any host that skips Nitro plugins.
 *
 * A failure is never cached: the second caller must not be told the check passed.
 */
export function ensureBootConfigChecked(): ConfigFinding[] {
  const store = globalThis as Record<string, unknown>;
  const cached = store[BOOT_CHECK_FLAG] as ConfigFinding[] | undefined;
  if (cached) return cached;
  const findings = assertBootConfig();
  store[BOOT_CHECK_FLAG] = findings;
  return findings;
}
