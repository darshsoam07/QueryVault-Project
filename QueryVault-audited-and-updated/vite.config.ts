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

/** The `nitro` option as the wrapper declares it — see `nitroOptions` below. */
type WrapperNitroOptions = NonNullable<NonNullable<Parameters<typeof defineConfig>[0]>["nitro"]>;

/**
 * Path of the Nitro startup plugin that validates configuration before the
 * listener accepts traffic. Exported so a test can assert it still exists and is
 * still referenced — see src/lib/__tests__/config.test.ts.
 */
export const BOOT_GUARD_PLUGIN = "./server/plugins/config-guard.ts";

/**
 * True inside the Lovable build environment, detected with the same two signals
 * the config wrapper itself uses.
 */
const isLovableBuild =
  process.env["LOVABLE_SANDBOX"] === "1" || !!process.env["DEV_SERVER__PROJECT_PATH"];

/**
 * Nitro options, with the boot guard registered for Node targets.
 *
 * `src/server.ts` is not early enough for this check: Nitro emits the SSR entry
 * into a chunk it imports on the *first request*, so a misconfigured container
 * would come up, log "Listening", answer the liveness probe 200 and then 500
 * every page. Nitro plugins run during app initialisation, which is before the
 * listener serves.
 *
 * The cast covers exactly one gap. `@lovable.dev/vite-tanstack-config` forwards
 * the whole object verbatim — its build path is literally
 * `nitro({ defaultPreset, ...userNitroOpts })` — but its *public type* admits only
 * `preset`/`output`/`cloudflare`, documented as "narrow on purpose … while Nitro
 * v3 is pre-RC". So `plugins` reaches Nitro and works (verified: with a
 * cross-project key the process exits before printing "Listening"); the type just
 * does not describe it. Keeping the cast on this one value leaves `preset` and
 * every other option in this file type-checked.
 *
 * Registration is explicit rather than by convention because Nitro v3 defaults
 * `serverDir: false` — nothing under `server/` is scanned unless that is turned
 * on, which would also enable route and auto-import scanning this app does not
 * want. Verified: with the file present but unlisted, the guard appeared only in
 * the lazy SSR chunk.
 *
 * It is skipped inside the Lovable build because that path overrides `preset` to
 * `cloudflare-module` but keeps whatever `plugins` were passed, and the guard is
 * Node-shaped: it reads `process.env` during initialisation and exits the process
 * on a fatal finding. On Workers the server configuration arrives through
 * bindings, so the guard would see an empty environment and refuse to start —
 * breaking the hosted preview to protect a deployment path it is not on. The
 * container target keeps the guard; `src/server.ts` remains the backstop for
 * both.
 */
const nitroOptions = {
  preset: process.env["NITRO_PRESET"] || "node-server",
  ...(isLovableBuild ? {} : { plugins: [BOOT_GUARD_PLUGIN] }),
} as WrapperNitroOptions;

// Phase 6A: the AWS/ECS target is a standard Node production server.
// Nitro's `node-server` preset emits `.output/server/index.mjs` (run with `npm run start`).
// Inside the Lovable build environment this option is ignored and the platform's own
// Cloudflare target is used, so the hosted preview/publish flow is unchanged.
export default defineConfig({
  plugins: [publicConfigGuard()],
  nitro: nitroOptions,
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
