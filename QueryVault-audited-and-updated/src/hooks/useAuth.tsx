/**
 * useAuth — single source of truth for the current Supabase session.
 *
 * Phase 1 fix: the previous implementation ran both `onAuthStateChange` AND a
 * parallel `getSession()` call. supabase-js v2 fires an `INITIAL_SESSION` event
 * as the very first `onAuthStateChange` callback, so the parallel getSession()
 * was redundant. Running both produced two concurrent state updates:
 *
 *   - `onAuthStateChange` INITIAL_SESSION → setSession(X), setLoading(false)
 *   - `getSession()` resolves             → setSession(X), setLoading(false)  → duplicate
 *
 * In React 18 strict mode, or when the event and promise settled in a different
 * order, this caused a flash of `loading: true / session: null` after the user
 * was already authenticated, redirecting the chat shell back to /auth mid-session.
 *
 * Fix: remove `getSession()` entirely. Rely solely on `onAuthStateChange`.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Session, User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // onAuthStateChange fires INITIAL_SESSION immediately with the persisted
    // session (or null when none exists). No parallel getSession() needed.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const user: User | null = session?.user ?? null;
  return { session, user, loading };
}
