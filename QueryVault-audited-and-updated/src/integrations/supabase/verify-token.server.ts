/**
 * Server-side bearer-token verification for API routes.
 *
 * `/api/chat` built its own user-scoped Supabase client inline, duplicating the
 * `apikey`/`Authorization` header dance that already existed in three other
 * files. This is the single implementation for API routes.
 *
 * The client returned here is scoped to the caller's access token and uses the
 * PUBLISHABLE key, so every query it makes is still subject to Row Level
 * Security. It is not an admin client and must never be swapped for one:
 * authentication tells us who is asking, RLS decides what they may see.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { assertSupabaseConfig, createSupabaseFetch } from "./api-key";
import type { Database } from "./types";

export type UserScopedClient = SupabaseClient<Database>;

/**
 * Builds an RLS-respecting client that acts as the bearer of `token`.
 *
 * Note the ordering inside the fetch wrapper: the shared wrapper sets `apikey`
 * and strips a self-referential `Authorization`, then we set the user's token.
 * That is what makes PostgREST evaluate `auth.uid()` as this user rather than
 * as the anonymous role.
 */
export function createUserScopedClient(token: string): UserScopedClient {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const publishableKey = process.env["SUPABASE_PUBLISHABLE_KEY"];
  assertSupabaseConfig({ SUPABASE_URL: supabaseUrl, SUPABASE_PUBLISHABLE_KEY: publishableKey });

  const baseFetch = createSupabaseFetch(publishableKey!);

  return createClient<Database>(supabaseUrl!, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return baseFetch(input, { ...init, headers });
      },
    },
  });
}

export type VerifiedCaller = { userId: string; supabase: UserScopedClient };

/**
 * Verifies an access token against the auth server and returns the caller.
 * Returns null for any invalid, expired or malformed token.
 *
 * This uses `auth.getUser`, which is a network call, rather than the local
 * claims check used by `requireSupabaseAuth`. The difference is deliberate:
 * `getUser` also confirms the account still exists and is not banned, so a
 * token belonging to a deleted user is rejected immediately instead of
 * remaining valid until it expires.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedCaller | null> {
  // Cheap structural check first: an access token is a three-part JWT with no
  // empty part. This avoids a network round trip for obvious junk. Counting
  // separators alone is not enough — ".." splits into three empty strings and
  // would otherwise be forwarded to the auth server as if it were plausible.
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;

  const supabase = createUserScopedClient(token);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, supabase };
}

/** Convenience for callers that need only the identity. */
export async function userIdFromToken(token: string): Promise<string | null> {
  const caller = await verifyAccessToken(token);
  return caller?.userId ?? null;
}
