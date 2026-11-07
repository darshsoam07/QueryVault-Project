import { defineConfig, devices } from "@playwright/test";
import { assertLoopbackHttpUrl } from "./src/lib/cost-policy";

// Never load the hosted .env into a browser test or service-role test client.
const baseURL = process.env["PLAYWRIGHT_BASE_URL"] || "http://127.0.0.1:5173";
assertLoopbackHttpUrl(baseURL);
const supabaseURL = process.env["VITE_SUPABASE_URL"] || "http://127.0.0.1:54321";
assertLoopbackHttpUrl(supabaseURL);
assertLoopbackHttpUrl(process.env["SUPABASE_URL"] || supabaseURL);
process.env["VITE_SUPABASE_URL"] = supabaseURL;
process.env["SUPABASE_URL"] = supabaseURL;
process.env["VITE_SUPABASE_PROJECT_ID"] = "queryvault-zero-cost";
process.env["SUPABASE_PROJECT_ID"] = "queryvault-zero-cost";
process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||= "sb_publishable_offline_fixture";
process.env["SUPABASE_PUBLISHABLE_KEY"] = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
if (process.env["QV_E2E_ISOLATED"] !== "1")
  process.env["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_offline_fixture";
process.env["QV_LOCAL_ONLY"] = "1";
process.env["VITE_QV_LOCAL_ONLY"] = "1";
process.env["QV_CONFIRMED_FREE_TIER"] = "0";
process.env["RUN_LIVE_GEMINI_TESTS"] = "0";
process.env["INGESTION_WORKER_SECRET"] = "offline-worker-fixture";
process.env["QV_TRACE_CONTENT"] = "0";
for (const key of ["GEMINI_API_KEY", "OPENAI_API_KEY", "LOVABLE_API_KEY", "AI_API_KEY"])
  process.env[key] = "";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: process.env["QV_BROWSER_CHANNEL"] },
    },
  ],
  webServer: {
    command:
      process.env["QV_E2E_PREBUILT"] === "1"
        ? "node .output/server/index.mjs"
        : `npm run dev -- --host 127.0.0.1 --configLoader native --port 5173${process.env["QV_E2E_COLD_START"] === "1" ? " --force" : ""}`,
    env: { NITRO_PORT: new URL(baseURL).port || "5173", NITRO_HOST: "127.0.0.1" },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
