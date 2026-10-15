import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// Explicit local profile; do not copy/load the existing hosted .env here.
const path = resolve(".env.zero-cost.local");
let source;
try {
  source = readFileSync(path, "utf8");
} catch {
  throw new Error(
    "Prepare .env.zero-cost.local from config/zero-cost.env.example and obtain keys from a LOCAL Supabase stack. Existing hosted .env is not used as a fallback.",
  );
}
const config = {};
const allowed = new Set([
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PROJECT_ID",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_PROJECT_ID",
  "INGESTION_WORKER_SECRET",
]);
for (const line of source.split(/\r?\n/)) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 1 || !allowed.has(line.slice(0, index).trim()))
    throw new Error("Unexpected zero-cost configuration field.");
  config[line.slice(0, index).trim()] = line
    .slice(index + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
}
for (const key of ["SUPABASE_URL", "VITE_SUPABASE_URL"]) {
  const url = new URL(config[key] ?? "");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Zero-cost development requires local Supabase URLs.");
}
if (config.SUPABASE_URL !== config.VITE_SUPABASE_URL)
  throw new Error("Local Supabase URLs must match.");
for (const key of [
  "SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "INGESTION_WORKER_SECRET",
]) {
  if (!config[key] || /REPLACE|placeholder/i.test(config[key]))
    throw new Error(`Configure ${key} from local resources before starting.`);
}
const env = {
  ...process.env,
  ...config,
  QV_LOCAL_ONLY: "1",
  VITE_QV_LOCAL_ONLY: "1",
  RUN_LIVE_GEMINI_TESTS: "0",
  QV_CONFIRMED_FREE_TIER: "0",
  QV_E2E_ISOLATED: "0",
  QV_TRACE_CONTENT: "0",
};
// Place empty values in the inherited environment so dotenv cannot restore keys.
for (const key of ["GEMINI_API_KEY", "OPENAI_API_KEY", "LOVABLE_API_KEY", "AI_API_KEY"])
  env[key] = "";
console.log(
  "Starting loopback-only development; all AI inference/embedding requests disabled. No model/backend changed.",
);
const child = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--mode", "zero-cost"],
  { env, stdio: "inherit" },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
