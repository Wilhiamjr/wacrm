-- ============================================================
-- 040_whatsapp_provider
--
-- Introduces the WhatsApp *provider* abstraction: accounts may
-- connect to the official Meta Cloud API (existing behaviour) OR to a
-- self-hosted WAHA instance. Two columns drive the switch:
--
--   1. `whatsapp_config.provider` — 'meta' (default) or 'waha'.
--      Every existing row keeps working untouched (defaults to 'meta').
--
--   2. `whatsapp_config.provider_config` — JSONB with provider-specific
--      settings. For 'waha', the shape is:
--
--        {
--          "baseUrl":     "http://localhost:3000",  -- WAHA instance URL
--          "apiKey":      "<X-Api-Key>",             -- encrypted at rest
--          "sessionName": "default",                 -- WAHA session
--          "webhookSecret": "<secret>"               -- HMAC-sha512 signing
--        }
--
-- The Meta-only columns (phone_number_id, waba_id, registered_at,
-- subscribed_apps_at, verify_token, last_registration_error) remain —
-- they carry the documentation of a Meta connection and are simply
-- ignored while a row is set to 'waha'.
--
-- No backfill: existing rows already mean "Meta", which is exactly
-- the default.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'waha'));

COMMENT ON COLUMN whatsapp_config.provider IS
  'WhatsApp backend: ''meta'' (official Cloud API) or ''waha'' (self-hosted '
  'WhatsApp HTTP API). Determines which provider the send paths and webhook '
  'parsers use. Defaults to ''meta'' so pre-040 rows keep working untouched.';

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN whatsapp_config.provider_config IS
  'Provider-specific settings. For ''waha'': baseUrl, apiKey (encrypted), '
  'sessionName, webhookSecret. Ignored for ''meta'' (everything lives on the '
  'Meta-specific columns above).';

-- A WAHA row carries no Meta Cloud API credentials, so the two NOT NULL
-- Meta columns must be relaxable. Pre-040 rows keep their values; the
-- UNIQUE(phone_number_id) constraint still allows multiple NULLs, so
-- several WAHA accounts can coexist without placeholder collisions.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

COMMENT ON COLUMN whatsapp_config.phone_number_id IS
  'Meta Cloud API phone-number id. NULL for provider=''waha'' rows.';
COMMENT ON COLUMN whatsapp_config.access_token IS
  'Meta Cloud API access token (AES-256-GCM encrypted). NULL for '
  'provider=''waha'' rows — WAHA credentials live in provider_config.';