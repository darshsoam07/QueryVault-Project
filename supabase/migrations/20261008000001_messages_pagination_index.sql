-- Migration: 20261008000001_messages_pagination_index.sql
-- Optimizes cursor-based pagination for conversation messages:
-- WHERE thread_id = $1 AND (created_at < $2 OR (created_at = $2 AND id < $3))
-- ORDER BY created_at DESC, id DESC LIMIT 50

CREATE INDEX IF NOT EXISTS messages_thread_pagination_idx
  ON public.messages (thread_id, created_at DESC, id DESC);
