// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

// Explicit extension: Vite's `configLoader: 'native'` (a future default) resolves
// this import through Node, which does not do extensionless resolution.
import { formatFindings, validateSupabaseConfig } from "./src/lib/config/validate.ts";

/**
 * Fails a production build whose public config is missing or a placeholder.
 *
 * `VITE_*` values are inlined into the client bundle at build time, so a build
 * that runs without them produces an artifact that answers `401 Invalid API key`
 * for every user, in every browser, with no way to correct it at deploy time.
 * The only place that mistake is cheap to catch is here.
 *
 * CI legitimately builds with throwaway placeholders to verify that the build
 * works at all. That is allowed, but it has to be *declared*:
 * `QV_ALLOW_PLACEHOLDER_CONFIG=1`. An undeclared placeholder build is the bug.
 */
function publicConfigGuard(): Plugin {
  return {
    name: "queryvault:public-config-guard",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      // SSR passes read the same env; one report per build is enough.
      if (config.build.ssr) return;

      const declared = (process.env["QV_ALLOW_PLACEHOLDER_CONFIG"] ?? "").trim().length > 0;
      const findings = validateSupabaseConfig(
        {
          VITE_SUPABASE_URL: config.env["VITE_SUPABASE_URL"] as string | undefined,
          VITE_SUPABASE_PUBLISHABLE_KEY: config.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as
            string | undefined,
          VITE_SUPABASE_PROJECT_ID: config.env["VITE_SUPABASE_PROJECT_ID"] as string | undefined,
        },
        ["public"],
      ).filter((finding) => finding.severity === "error");

      if (findings.length === 0) return;

      // A secret in a VITE_ variable is never acceptable, declared or not: the
      // build would publish an RLS-bypassing key to every browser.
      const publishesSecret = findings.some((f) => f.code === "CONFIG_SECRET_IN_PUBLIC");

      if (declared && !publishesSecret) {
        config.logger.warn(
          `[public-config] building with placeholder public config (QV_ALLOW_PLACEHOLDER_CONFIG set).\n` +
            `${formatFindings(findings)}\n` +
            `[public-config] this artifact must not be deployed.`,
        );
        return;
      }

      throw new Error(
        `Refusing to build: public configuration is not deployable.\n${formatFindings(findings)}\n` +
          `  VITE_* values are inlined at build time — an artifact built without them ` +
          `fails every request with "Invalid API key".\n` +
          `  Set them in .env, or set QV_ALLOW_PLACEHOLDER_CONFIG=1 for a throwaway ` +
          `verification build that will not be deployed.`,
      );
    },
  };
}

// Phase 6A: the AWS/ECS target is a standard Node production server.
// Nitro's `node-server` preset emits `.output/server/index.mjs` (run with `npm run start`).
// Inside the Lovable build environment this option is ignored and the platform's own
// Cloudflare target is used, so the hosted preview/publish flow is unchanged.
export default defineConfig({
  plugins: [publicConfigGuard()],
  nitro: {
    preset: process.env["NITRO_PRESET"] || "node-server",
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
