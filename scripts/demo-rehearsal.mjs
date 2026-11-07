import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Build the real application with loopback-only fixture values, then exercise
// it in Chromium. Playwright owns the server lifecycle and HTTP fixtures.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(?:VITE_|QV_|SUPABASE_|AI_|OPENAI_|GEMINI_|LOVABLE_|INGESTION_|PLAYWRIGHT_BASE_URL|NITRO_|PORT$|HOST$|RUN_LIVE_)/i.test(
        key,
      ),
  ),
);
const temp = resolve(".verification/demo-temp");
mkdirSync(temp, { recursive: true });
Object.assign(env, {
  TEMP: temp,
  TMP: temp,
  QV_LOCAL_ONLY: "1",
  VITE_QV_LOCAL_ONLY: "1",
  RUN_LIVE_GEMINI_TESTS: "0",
  QV_CONFIRMED_FREE_TIER: "0",
  QV_E2E_ISOLATED: "0",
  QV_E2E_PREBUILT: "1",
  PLAYWRIGHT_BASE_URL: "http://127.0.0.1:5197",
  QV_ALLOW_PLACEHOLDER_CONFIG: "1",
  SUPABASE_URL: "http://127.0.0.1:54321",
  VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PROJECT_ID: "queryvault-zero-cost",
  VITE_SUPABASE_PROJECT_ID: "queryvault-zero-cost",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_offline_fixture",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_offline_fixture",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_offline_fixture",
  INGESTION_WORKER_SECRET: "offline-worker-fixture",
});
const installedChrome =
  process.platform === "win32" &&
  existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe");
if (process.env.QV_BROWSER_CHANNEL || installedChrome)
  env.QV_BROWSER_CHANNEL = process.env.QV_BROWSER_CHANNEL || "chrome";
function run(args) {
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Building a browser rehearsal with fixture services. Keep this build local.");
run(["node_modules/vite/bin/vite.js", "build", "--configLoader", "native"]);
run([
  "node_modules/@playwright/test/cli.js",
  "test",
  "e2e/multi-document.spec.ts",
  "e2e/mocked-scroll.spec.ts",
  "e2e/demo-readiness.spec.ts",
  "--output",
  ".verification/demo-browser-results",
  ...process.argv.slice(2),
]);
