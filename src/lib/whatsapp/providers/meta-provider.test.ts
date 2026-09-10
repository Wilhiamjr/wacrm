import { describe, expect, it, vi } from 'vitest';

import { encrypt } from '@/lib/whatsapp/encryption';
import type { MirrorStorage } from '@/lib/whatsapp/mirror-inbound-media';
import type { WhatsAppConfig } from '@/types';

import { MetaCloudProvider } from './meta-provider';

const {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendReactionMessage,
  downloadMedia,
  getMediaUrl,
} = vi.hoisted(() => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-text' }),
  sendMediaMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-media' }),
  sendTemplateMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-tpl' }),
  sendReactionMessage: vi.fn().mockResolvedValue({ messageId: 'wamid-react' }),
  downloadMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from('bytes'),
    contentType: 'image/jpeg',
  }),
  getMediaUrl: vi.fn().mockResolvedValue({
    url: 'https://graph.facebook.com/media-1',
    mimeType: 'image/jpeg',
    fileSize: 123,
  }),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendReactionMessage,
  downloadMedia,
  getMediaUrl,
  sendInteractiveButtons: vi
    .fn()
    .mockResolvedValue({ messageId: 'wamid-btns' }),
  sendInteractiveList: vi.fn().mockResolvedValue({ messageId: 'wamid-list' }),
  verifyPhoneNumber: vi.fn().mockResolvedValue({ id: 'pn-1' }),
}));

function storage(): MirrorStorage & {
  uploaded: { path: string; contentType: string }[];
} {
  const uploaded: { path: string; contentType: string }[] = [];
  const bucket = {
    upload: vi.fn(
      async (path: string, _body: Buffer, opts: { contentType: string }) => {
        uploaded.push({ path, contentType: opts.contentType });
        return { error: null };
      }
    ),
    getPublicUrl: (path: string) => ({
      data: { publicUrl: `https://cdn/${path}` },
    }),
  };
  return { from: () => bucket, uploaded } as unknown as MirrorStorage & {
    uploaded: { path: string; contentType: string }[];
  };
}

function config(over: Partial<WhatsAppConfig> = {}): WhatsAppConfig {
  return {
    id: 'wc-1',
    user_id: 'u-1',
    phone_number_id: 'pn-1',
    access_token: encrypt('tok-1'),
    ...over,
  } as WhatsAppConfig;
}

describe('MetaCloudProvider outbound', () => {
  it('sendText delegates to sendTextMessage with the account context', async () => {
    const p = new MetaCloudProvider({ config: config() });
    const res = await p.sendText({ to: '5511987654321', text: 'oi' });
    expect(res.messageId).toBe('wamid-text');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'tok-1',
        to: '5511987654321',
      })
    );
  });

  it('sendMedia passes kind/url/caption through', async () => {
    const p = new MetaCloudProvider({ config: config() });
    await p.sendMedia({
      to: '5511987654321',
      kind: 'image',
      url: 'https://cdn/x.jpg',
      caption: 'foto',
    });
    expect(sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'image',
        link: 'https://cdn/x.jpg',
        caption: 'foto',
      })
    );
  });

  it('sendTemplate delegates raw params', async () => {
    const p = new MetaCloudProvider({ config: config() });
    await p.sendTemplate({
      to: '5511987654321',
      templateName: 'order_update',
      params: ['A123'],
    });
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'order_update',
        params: ['A123'],
      })
    );
  });

  it('sendReaction supplies the recipient', async () => {
    const p = new MetaCloudProvider({ config: config() });
    await p.sendReaction({ targetMessageId: 'wamid-1', emoji: '👍' });
    expect(sendReactionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '',
        targetMessageId: 'wamid-1',
        emoji: '👍',
      })
    );
  });

  it('throws when the row has no phone number or token', async () => {
    const p = new MetaCloudProvider({
      config: config({ phone_number_id: '', access_token: '' }),
    });
    await expect(p.sendText({ to: 'x', text: 'oi' })).rejects.toThrow(
      /missing/i
    );
  });
});

describe('MetaCloudProvider parseWebhook', () => {
  it('parses a text message', () => {
    const p = new MetaCloudProvider({ config: config() });
    const events = p.parseWebhook({
      entry: [
        {
          id: 'waid',
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid-1',
                    from: '5511987654321',
                    timestamp: '1750000000',
                    type: 'text',
                    text: { body: 'salve' },
                  },
                ],
                contacts: [
                  { profile: { name: 'Ana' }, wa_id: '5511987654321' },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'message',
      provider: 'meta',
      messageId: 'wamid-1',
      phoneNumber: '5511987654321',
      messageType: 'text',
      text: 'salve',
      contactName: 'Ana',
    });
  });

  it('parses a status webhook', () => {
    const p = new MetaCloudProvider({ config: config() });
    const events = p.parseWebhook({
      entry: [
        {
          id: 'waid',
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: 'wamid-9',
                    status: 'read',
                    timestamp: '1750000001',
                    recipient_id: '5511987654321',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]).toMatchObject({
      kind: 'status',
      status: 'read',
      phoneNumber: '5511987654321',
    });
  });

  it('parses an interactive button reply into the interactive shape', () => {
    const p = new MetaCloudProvider({ config: config() });
    const events = p.parseWebhook({
      entry: [
        {
          id: 'waid',
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid-3',
                    from: '5511987654321',
                    timestamp: '1750000002',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'btn-1', title: 'Sim' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]).toMatchObject({
      kind: 'message',
      messageType: 'interactive',
      interactive: { kind: 'button_reply', id: 'btn-1', title: 'Sim' },
    });
  });

  it('maps a message type "reaction" to a reaction event', () => {
    const p = new MetaCloudProvider({ config: config() });
    const events = p.parseWebhook({
      entry: [
        {
          id: 'waid',
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid-4',
                    from: '5511987654321',
                    timestamp: '1750000003',
                    type: 'reaction',
                    reaction: { message_id: 'wamid-0', emoji: '👍' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]).toMatchObject({
      kind: 'reaction',
      reaction: { targetMessageId: 'wamid-0', emoji: '👍' },
    });
  });

  it('returns [] for a null or empty envelope', () => {
    const p = new MetaCloudProvider({ config: config() });
    expect(p.parseWebhook(null)).toEqual([]);
    expect(p.parseWebhook({ entry: [] })).toEqual([]);
  });
});

describe('MetaCloudProvider verifyWebhook', () => {
  it('fails closed on a wrong signature', () => {
    const p = new MetaCloudProvider({ config: config() });
    expect(
      p.verifyWebhook!('{"a":1}', { 'x-hub-signature-256': 'sha256=0000' })
    ).toBe(false);
  });
});

describe('MetaCloudProvider resolveInboundMedia', () => {
  it('mirrors into chat-media when mirrorMedia is on and returns the public URL', async () => {
    const st = storage();
    const p = new MetaCloudProvider({ config: config(), storage: st });
    const result = await p.resolveInboundMedia(
      {
        url: '/api/whatsapp/media/media-1',
        mimeType: 'image/jpeg',
        id: 'media-1',
      },
      {
        accountId: 'acct-1',
        mirrorMedia: true,
        messageId: 'm-1',
        timestamp: 1000,
      }
    );
    expect(result.url).toContain('https://cdn/');
    expect(st.uploaded).toHaveLength(1);
    expect(st.uploaded[0].contentType).toBe('image/jpeg');
  });

  it('keeps the proxy URL when mirror is disabled', async () => {
    const p = new MetaCloudProvider({ config: config() });
    const result = await p.resolveInboundMedia(
      { url: '/api/whatsapp/media/media-1', mimeType: 'image/jpeg' },
      {
        accountId: 'acct-1',
        mirrorMedia: false,
        messageId: 'm-1',
        timestamp: 1000,
      }
    );
    expect(result.url).toBe('/api/whatsapp/media/media-1');
  });
});
