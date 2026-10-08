#!/usr/bin/env bash
# Regenerates supabase/bootstrap.sql from supabase/migrations/*.sql.
set -euo pipefail
cd "$(dirname "$0")/.."
{
  printf -- '-- ===========================================================================
-- QueryVault — GENERATED bootstrap script. DO NOT EDIT BY HAND.
--
-- Every migration in supabase/migrations/, concatenated in filename order.
-- Use when you have no Supabase CLI / psql access: paste the whole file into
-- Supabase Dashboard -> SQL Editor -> Run. Safe to run on an empty project.
--
-- Regenerate after adding a migration:
--   bash scripts/generate-bootstrap.sh
-- ===========================================================================

'
  for f in $(ls -1 supabase/migrations/*.sql | sort); do
    printf -- '
-- ---------------------------------------------------------------------------
-- %s
-- ---------------------------------------------------------------------------
' "$(basename "$f")"
    cat "$f"
    printf '
'
  done
} > supabase/bootstrap.sql
echo "wrote supabase/bootstrap.sql ($(wc -l < supabase/bootstrap.sql) lines, $(ls -1 supabase/migrations/*.sql | wc -l) migrations)"
