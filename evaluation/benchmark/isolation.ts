import { z } from "zod";
import { assertLoopbackHttpUrl } from "../../src/lib/cost-policy";

const providerKeys = ["AI_PROVIDER", "AI_BASE_URL", "AI_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "LOVABLE_API_KEY", "GEMINI_BASE_URL", "AI_CHAT_MODEL", "AI_UTILITY_MODEL", "AI_EMBEDDING_MODEL", "AI_EMBEDDING_DIMENSIONS", "GEMINI_CHAT_MODEL", "GEMINI_UTILITY_MODEL", "GEMINI_EMBEDDING_MODEL"] as const;
export const localConfigSchema = z.object({
  projectId: z.literal("queryvault-benchmark"), supabaseUrl: z.string().url(),
  publishableKey: z.string().min(1), serviceRoleKey: z.string().min(1),
  provider: z.record(z.string()).refine(p => Object.keys(p).every(k => providerKeys.includes(k as typeof providerKeys[number])), "Unexpected provider setting"),
}).strict();
export type LocalConfig = z.infer<typeof localConfigSchema>;
export function assertLocalConfig(config: LocalConfig, live: boolean) {
  if (!live) throw new Error("LIVE_OPT_IN_REQUIRED");
  if (config.projectId !== "queryvault-benchmark") throw new Error("ISOLATED_PROJECT_REQUIRED");
  assertLoopbackHttpUrl(config.supabaseUrl);
  const url = new URL(config.supabaseUrl);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash || !url.port) throw new Error("EXPLICIT_LOOPBACK_PORT_REQUIRED");
}
export function assertContainer(container: {Name?: string; State?: {Running?: boolean}; Mounts?: Array<{Type: string}>; NetworkSettings?: {Ports?: Record<string, Array<{HostIp: string; HostPort: string}> | null>}}, name: string, apiPort?: string) {
  if (container.Name !== `/${name}` || !container.State?.Running || !container.Mounts || container.Mounts.some(m => m.Type !== "volume" && m.Type !== "tmpfs")) throw new Error("DEDICATED_CONTAINER_REQUIRED");
  if (apiPort && !container.NetworkSettings?.Ports?.["8000/tcp"]?.some(p => p.HostIp === "127.0.0.1" && p.HostPort === apiPort)) throw new Error("LOOPBACK_CONTAINER_BINDING_REQUIRED");
}
export function configureEnvironment(config: LocalConfig) {
  // No inherited production configuration. CLI must run with Bun --no-env-file.
  for (const key of Object.keys(process.env))
    if (/^(SUPABASE_|VITE_|AI_|GEMINI_|OPENAI_|LOVABLE_|QV_|INGESTION_)/.test(key)) delete process.env[key];
  Object.assign(process.env, config.provider, {
    SUPABASE_URL: config.supabaseUrl, SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    SUPABASE_SERVICE_ROLE_KEY: config.serviceRoleKey, SUPABASE_PROJECT_ID: config.projectId,
    QV_TRACE_CONTENT: "0", INGESTION_WORKER_SECRET: "benchmark-local-unused-http-secret",
  });
}
export function restrictedFetch(delegate: typeof fetch, supabaseUrl: string, providerUrl: string): typeof fetch {
  const origins = new Set([new URL(supabaseUrl).origin, new URL(providerUrl).origin]);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!origins.has(url.origin) || url.username || url.password) throw new Error("BENCHMARK_NETWORK_BOUNDARY");
    return delegate(input, { ...init, redirect: "error", signal: init?.signal ?? (input instanceof Request ? input.signal : AbortSignal.timeout(90_000)) });
  };
}
