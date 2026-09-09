// ============================================================
// WhatsApp provider factory.
//
// Picks the provider implementation from an account's
// `whatsapp_config` row. The row's `provider` column (migration 040)
// selects the backend; `provider_config` carries per-provider settings
// such as the WAHA base URL / api key / session name.
//
// The Meta provider needs a DECRYPTED token to send — callers must
// pass it explicitly (they already hold the plaintext after
// `decrypt(config.access_token)`). The WAHA provider reads everything
// from `provider_config`; its `apiKey` / `webhookSecret` fields are
// stored encrypted (same AES-256-GCM envelope as the Meta token) and
// are decrypted here lazily.
// ============================================================

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import type { WhatsAppConfig } from '@/types';
import { MetaCloudProvider, type MetaProviderOptions } from './meta-provider';
import { WahaProvider } from './waha-provider';
import { ProviderConfigurationError, type ProviderConfig, type WhatsAppProvider } from './types';

export type { WhatsAppProvider };
export * from './types';
export { MetaCloudProvider } from './meta-provider';
export { WahaProvider, wahaChatIdToPhone, phoneToWahaChatId } from './waha-provider';

export interface GetProviderOptions {
  /** Pre-decrypted Meta token. Required for the meta provider. */
  accessToken?: string;
  storage?: MetaProviderOptions['storage'];
}

/**
 * Build the provider for a config row.
 *
 * @throws ProviderConfigurationError when the row names an unknown
 *         provider (e.g. a provider added by a rollback that the code
 *         no longer ships), or when a stored-encrypted provider_config
 *         field fails to decrypt.
 */
export function getWhatsAppProvider(
  config: Partial<WhatsAppConfig>,
  opts: GetProviderOptions = {},
): WhatsAppProvider {
  const provider = config.provider ?? 'meta';

  switch (provider) {
    case 'meta':
      return new MetaCloudProvider({
        accessToken: opts.accessToken ?? (config.access_token ? decrypt(config.access_token) : ''),
        config,
        storage: opts.storage,
      });
    case 'waha':
      return new WahaProvider({
        providerConfig: decryptProviderConfig(config.provider_config ?? {}),
        storage: opts.storage,
      });
    default:
      throw new ProviderConfigurationError(
        `Unknown WhatsApp provider "${provider}". ` +
          'Supported providers: meta, waha.',
      );
  }
}

export function isProviderConfigReady(config: Partial<WhatsAppConfig>): boolean {
  switch (config.provider ?? 'meta') {
    case 'meta':
      return Boolean(config.phone_number_id && config.access_token);
    case 'waha': {
      const pc = config.provider_config ?? {};
      return Boolean(pc.baseUrl && pc.apiKey && pc.sessionName);
    }
    default:
      return false;
  }
}

/**
 * Fields of `provider_config` that are stored encrypted (AES-256-GCM,
 * same envelope as `whatsapp_config.access_token`). Everything else is
 * stored plain.
 */
const ENCRYPTED_PROVIDER_FIELDS = ['apiKey', 'webhookSecret'] as const;

/**
 * Decrypt the fields of a waha `provider_config` read from the DB.
 * Plain values (no colon → not our encrypted envelope) pass through
 * untouched, which keeps hand-written configs and older rows working.
 */
export function decryptProviderConfig(pc: ProviderConfig): ProviderConfig {
  const out: ProviderConfig = { ...pc };
  for (const field of ENCRYPTED_PROVIDER_FIELDS) {
    const value = out[field];
    if (typeof value !== 'string' || !value.includes(':')) continue;
    try {
      out[field] = decrypt(value);
    } catch (error) {
      throw new ProviderConfigurationError(
        `Cannot decrypt whatsapp_config.provider_config.${field}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return out;
}

/** Encrypt the sensitive fields before writing a waha `provider_config`. */
export function encryptProviderConfig(pc: ProviderConfig): ProviderConfig {
  const out: ProviderConfig = { ...pc };
  for (const field of ENCRYPTED_PROVIDER_FIELDS) {
    const value = out[field];
    if (typeof value === 'string' && value && !value.includes(':')) {
      out[field] = encrypt(value);
    }
  }
  return out;
}