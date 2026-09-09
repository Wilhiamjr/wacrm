import { describe, expect, it, vi } from 'vitest';

import { encrypt } from '@/lib/whatsapp/encryption';
import type { WhatsAppConfig } from '@/types';

import {
  getWhatsAppProvider,
  isProviderConfigReady,
  ProviderConfigurationError,
} from './index';
import { MetaCloudProvider } from './meta-provider';

vi.mock('@/lib/whatsapp/meta-api', () => ({
  downloadMedia: vi.fn(),
  getMediaUrl: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendReactionMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}));

function config(over: Partial<WhatsAppConfig>): WhatsAppConfig {
  return {
    id: 'wc-1',
    user_id: 'u-1',
    phone_number_id: 'pn-1',
    access_token: encrypt('tok-1'),
    status: 'connected',
    ...over,
  } as WhatsAppConfig;
}

describe('getWhatsAppProvider', () => {
  it('returns a MetaCloudProvider by default (pre-040 rows)', () => {
    const p = getWhatsAppProvider(config({}));
    expect(p).toBeInstanceOf(MetaCloudProvider);
    expect(p.name).toBe('meta');
  });

  it('returns a MetaCloudProvider when provider is meta', () => {
    const p = getWhatsAppProvider(config({ provider: 'meta' }));
    expect(p.name).toBe('meta');
  });

  it('returns a WahaProvider when provider is waha', () => {
    const p = getWhatsAppProvider(
      config({
        provider: 'waha',
        provider_config: { baseUrl: 'http://localhost:3000', apiKey: 'k', sessionName: 'sessions' },
      }),
    );
    expect(p.name).toBe('waha');
  });

  it('throws ProviderConfigurationError for an unknown provider', () => {
    expect(() =>
      getWhatsAppProvider(config({ provider: 'telegram' as never })),
    ).toThrow(ProviderConfigurationError);
  });
});

describe('isProviderConfigReady', () => {
  it('meta needs phone_number_id + access_token', () => {
    expect(isProviderConfigReady(config({ provider: 'meta' }))).toBe(true);
    expect(
      isProviderConfigReady(config({ phone_number_id: '', access_token: '', provider: 'meta' })),
    ).toBe(false);
  });

  it('waha needs baseUrl + apiKey + sessionName', () => {
    expect(
      isProviderConfigReady(config({ provider: 'waha', provider_config: { baseUrl: 'x', apiKey: 'y', sessionName: 'z' } })),
    ).toBe(true);
    expect(isProviderConfigReady(config({ provider: 'waha', provider_config: {} }))).toBe(false);
  });
});