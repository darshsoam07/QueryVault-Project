import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Secret containment, enforced instead of merely documented.
    //
    // `*.server.ts` modules read SUPABASE_SERVICE_ROLE_KEY, the AI provider
    // credential and the worker secret. Nothing but the `.server` suffix has
    // ever stopped a component from importing one, and a single such import
    // would have Vite bundle that module — and the code that reads those
    // secrets — into the browser payload.
    //
    // Components, hooks and route components are the client-reachable surface,
    // so they may not import a server module at all. Server work belongs in an
    // API route under src/routes/api/ or behind createServerFn.
    files: ["src/components/**/*.{ts,tsx}", "src/hooks/**/*.{ts,tsx}", "**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/*.server", "**/*.server.ts", "**/*.server.js"],
              message:
                "Client-reachable code must not import a `*.server` module: those read secrets " +
                "(service role key, AI provider key) and importing one bundles them into the " +
                "browser. Call an API route under src/routes/api/ instead.",
            },
          ],
        },
      ],
    },
  },
  eslintPluginPrettier,
);
