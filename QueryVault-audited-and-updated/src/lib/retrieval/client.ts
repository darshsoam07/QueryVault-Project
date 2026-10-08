import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The retrievers only ever receive an auth-scoped Supabase client, so every
 * query runs under the caller's RLS context.
 */
export type RetrievalClient = SupabaseClient<Database>;
