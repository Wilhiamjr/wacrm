-- Drop whatsapp_config.status / connected_at — write-only columns.
--
-- `status` ('connected'|'disconnected') was written on every save and
-- read by exactly two callers: the GET /api/whatsapp/config health check
-- and the inbox connection banner. Both now derive the answer from the
-- LIVE provider state instead (verifyCredentials + getSessionStatus for
-- WAHA, Meta probing for Meta), so the column went stale and dead.
-- `connected_at` had zero readers. Removing both avoids the "is this
-- field still used?" tax for the next person reading the schema.

ALTER TABLE public.whatsapp_config
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS connected_at;