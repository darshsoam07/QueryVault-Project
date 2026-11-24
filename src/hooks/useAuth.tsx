/**
 * useAuth — single source of truth for the current Supabase session.
 *
 * Relies solely on `onAuthStateChange` (which fires `INITIAL_SESSION` immediately)
 * and keeps a browser-only in-memory cache so client-side route transitions
 * (`/auth` -> `/chat`) render on frame 0 without flashing a loading screen.
 * The cache is disabled during SSR and Vitest runs to prevent cross-request or
 * cross-test state leakage and preserve identical SSR/client hydration.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Session, User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

const canUseClientCache = () =>
  typeof window !== "undefined" && import.meta.env.MODE !== "test";

let cachedSession: Session | null = null;
let hasCachedSession = false;

/**
 * Seeds the in-memory browser session immediately after sign-in/sign-up so
 * `/chat` renders immediately without waiting for a second INITIAL_SESSION event.
 */
export function primeAuthSession(nextSession: Session | null): void {
  if (!canUseClientCache()) return;
  cachedSession = nextSession;
  hasCachedSession = true;
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(() =>
    canUseClientCache() && hasCachedSession ? cachedSession : null,
  );
  const [loading, setLoading] = useState<boolean>(() =>
    canUseClientCache() && hasCachedSession ? false : true,
  );

  useEffect(() => {
    // onAuthStateChange fires INITIAL_SESSION immediately with the persisted
    // session (or null when none exists). No parallel getSession() needed.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (canUseClientCache()) {
        cachedSession = nextSession;
        hasCachedSession = true;
      }
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
