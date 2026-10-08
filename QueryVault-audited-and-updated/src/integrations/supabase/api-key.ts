/**
 * Shared Supabase API-key handling.
 *
 * `isNewSupabaseApiKey` and `createSupabaseFetch` previously existed as three
 * byte-identical copies — in `client.ts`, `client.server.ts` and
 * `auth-middleware.ts` — plus a fourth inline variant in the chat route. A fix
 * to the header logic had to be made in four places or the copies would drift,
 * and drift in *this* logic means requests silently authenticate as the wrong
 * principal.
 *
 * Everything here is pure and isomorphic: no secret is read from the
 * environment, so this module is safe to import from browser code.
 */
import type { Database } from "./types";

/**
 * True for the current-generation Supabase key format (`sb_publishable_…`,
 * `sb_secret_…`) as opposed to the legacy signed JWTs (`eyJ…`).
 */
export function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

/**
 * Wraps `fetch` so every Supabase request carries the `apikey` header.
 *
 * The `Authorization` deletion matters: supabase-js defaults that header to
 * `Bearer <apiKey>`, which is correct for legacy JWT keys but wrong for the new
 * opaque keys — GoTrue tries to parse the opaque string as a JWT and rejects the
 * request. Removing it only when it still holds the key itself preserves a real
 * user token when one has been set.
 */
export function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }

    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

/**
 * Asserts that the named configuration values are present, with an error that
 * names what is missing and where to set it.
 *
 * The previous message ended "Connect Supabase in Lovable Cloud", which pointed
 * an operator of a self-hosted deployment at a product they are not using.
 * Never include the values themselves — this message reaches logs.
 */
export function assertSupabaseConfig(values: Record<string, string | undefined>): void {
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length === 0) return;

  const message =
    `Missing Supabase environment variable(s): ${missing.join(", ")}. ` +
    `Set them in .env (see .env.example) or in your deployment's secret store.`;
  console.error(`[supabase] ${message}`);
  throw new Error(message);
}

/** Re-exported so call sites need only one import for the typed client. */
export type { Database };
