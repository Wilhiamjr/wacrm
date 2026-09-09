import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

import type { MirrorStorage } from '@/lib/whatsapp/mirror-inbound-media';

import {
  phoneToWahaChatId,
  wahaChatIdToPhone,
  WahaProvider,
} from './waha-provider';

function storage(): MirrorStorage & { uploaded: unknown[] } {
  const uploaded: unknown[] = [];
  const bucket = {
    upload: vi.fn(async (path: string, _body: Buffer, opts: Record<string, unknown>) => {
      uploaded.push({ path, ...opts });
      return { error: null };
    }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn/${path}` } }),
  };
  return { from: () => bucket, uploaded } as unknown as MirrorStorage & { uploaded: unknown[] };
}

function makeProvider(over: { baseUrl?: string; webhookSecret?: string } = {}) {
  const providerConfig = {
    baseUrl: over.baseUrl ?? 'https://waha.test',
    apiKey: 'key-1',
    sessionName: 'default',
    webhookSecret: over.webhookSecret ?? 'secret-1',
  };
  const st = storage();
  const provider = new WahaProvider({ providerConfig, storage: st });
  return { provider, st };
}

describe('WAHA chat id helpers', () => {
  it('maps digits-only E.164 to @c.us', () => {
    expect(phoneToWahaChatId('5511987654321')).toBe('5511987654321@c.us');
  });

  it('strips @c.us and non-digits', () => {
    expect(wahaChatIdToPhone('+55 11 98765-4321@c.us')).toBe('5511987654321');
    expect(wahaChatIdToPhone('123-garbage')).toBe('123');
  });
});

describe('WahaProvider outbound', () => {
  it('sendText posts to /api/sendText with chatId and reply', async () => {
    const { provider } = makeProvider();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'wamid-waha' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await provider.sendText({ to: '5511987654321', text: 'oi', contextMessageId: 'wamid-0' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://waha.test/api/sendText');
    expect(JSON.parse(init.body)).toEqual({
      session: 'default',
      chatId: '5511987654321@c.us',
      text: 'oi',
      reply_to: 'wamid-0',
    });
    expect(init.headers['X-Api-Key']).toBe('key-1');
    expect(init.headers['Content-Type']).toBe('application/json');
    vi.unstubAllGlobals();
  });

  it('sendMedia routes image/video/document endpoints', async () => {
    const { provider } = makeProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'wamid-img' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await provider.sendMedia({ to: '5511987654321', kind: 'image', url: 'https://cdn/a.jpg', caption: 'cap' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://waha.test/api/sendImage');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).file.url).toBe('https://cdn/a.jpg');
    vi.unstubAllGlobals();
  });

  it('sendMedia routes audio to /api/sendVoice with convert true', async () => {
    const { provider } = makeProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'wamid-aud' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await provider.sendMedia({ to: '5511987654321', kind: 'audio', url: 'https://cdn/a.ogg' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://waha.test/api/sendVoice');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).convert).toBe(true);
    vi.unstubAllGlobals();
  });

  it('sendReaction uses PUT', async () => {
    const { provider } = makeProvider();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await provider.sendReaction({ targetMessageId: 'wamid-1', emoji: '👍' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://waha.test/api/reaction');
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      session: 'default',
      messageId: 'wamid-1',
      reaction: '👍',
    });
    vi.unstubAllGlobals();
  });

  it('generates a deterministic local id when WAHA omits the id', async () => {
    const { provider } = makeProvider();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await provider.sendText({ to: '5511987654321', text: 'x' });
    expect(res.messageId).toMatch(/^waha:5511987654321:/);
    vi.unstubAllGlobals();
  });
});

describe('WahaProvider verifyWebhook', () => {
  it('accepts a valid sha512 HMAC and rejects tampered bodies', () => {
    const { provider } = makeProvider({ webhookSecret: 'very-secret' });
    const raw = JSON.stringify({ event: 'message', payload: { id: 'x' } });
    const sig = crypto.createHmac('sha512', 'very-secret').update(raw).digest('hex');
    expect(provider.verifyWebhook!(raw, { 'x-webhook-hmac': sig })).toBe(true);

    const tampered = raw.replace('"id":"x"', '"id":"y"');
    const sigTampered = crypto.createHmac('sha512', 'very-secret').update(tampered).digest('hex');
    expect(provider.verifyWebhook!(tampered, { 'x-webhook-hmac': sig })).toBe(false);
    expect(provider.verifyWebhook!(raw, { 'x-webhook-hmac': sigTampered })).toBe(false);
  });

  it('fails closed when no secret is configured', () => {
    const { provider } = makeProvider({ webhookSecret: '' });
    expect(provider.verifyWebhook!('{}', { 'x-webhook-hmac': 'abcd' })).toBe(false);
  });
});

describe('WahaProvider parseWebhook', () => {
  it('parses an inbound text message', () => {
    const { provider } = makeProvider();
    const events = provider.parseWebhook({
      event: 'message',
      session: 'default',
      payload: {
        id: 'true_1',
        timestamp: 1750000000,
        from: '5511987654321@c.us',
        body: 'salve',
        fromMe: false,
        hasMedia: false,
      },
    });
    expect(events[0]).toMatchObject({
      kind: 'message',
      provider: 'waha',
      messageId: 'true_1',
      phoneNumber: '5511987654321',
      timestamp: 1750000000,
      messageType: 'text',
      text: 'salve',
    });
  });

  it('parses a media message with mimetype classification', () => {
    const { provider } = makeProvider();
    const events = provider.parseWebhook({
      event: 'message',
      payload: {
        id: 'true_2',
        timestamp: 1750000000,
        from: '5511987654321@c.us',
        hasMedia: true,
        media: { url: 'https://waha.test/files/x.jpg', mimetype: 'image/webp' },
      },
    });
    expect(events[0]).toMatchObject({
      kind: 'message',
      messageType: 'sticker',
      media: { mimeType: 'image/webp' },
    });
  });

  it('parses ack into the status ladder', () => {
    const { provider } = makeProvider();
    const events = provider.parseWebhook({
      event: 'message.ack',
      payload: { id: 'true_9', from: '5511987654321@c.us', ack: 3 },
    });
    expect(events[0]).toMatchObject({ kind: 'status', status: 'read', phoneNumber: '5511987654321' });
  });

  it('parses reactions', () => {
    const { provider } = makeProvider();
    const events = provider.parseWebhook({
      event: 'message.reaction',
      payload: {
        id: 'false_3',
        from: '5511987654321@c.us',
        reaction: { text: '👍', messageId: 'true_1' },
      },
    });
    expect(events[0]).toMatchObject({
      kind: 'reaction',
      reaction: { emoji: '👍', targetMessageId: 'true_1' },
    });
  });

  it('ignores irrelevant events', () => {
    const { provider } = makeProvider();
    expect(provider.parseWebhook({ event: 'session.status', payload: {} })).toEqual([]);
    expect(provider.parseWebhook({ event: 'app.connected' })).toEqual([]);
  });

  it('handles millisecond event timestamps', () => {
    const { provider } = makeProvider();
    const events = provider.parseWebhook({
      event: 'message',
      payload: { id: 'x', timestamp: 1750000000123, from: '5511987654321@c.us', body: 'oi' },
    });
    expect(events[0]!.timestamp).toBe(1750000000);
  });
});

describe('WahaProvider verifyCredentials / resolveInboundMedia', () => {
  it('verifyCredentials passes when the session is WORKING', async () => {
    const { provider } = makeProvider();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: 'default', status: 'WORKING' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await provider.verifyCredentials();
    expect(res).toEqual({ valid: true });
    expect(fetchMock.mock.calls[0][0]).toBe('https://waha.test/api/sessions/default');
    vi.unstubAllGlobals();
  });

  it('resolveInboundMedia mirrors and returns the public URL', async () => {
    const { provider, st } = makeProvider();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from('bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await provider.resolveInboundMedia(
      { url: 'https://waha.test/files/x', mimeType: 'image/jpeg' },
      { accountId: 'acct-1', mirrorMedia: true, messageId: 'm-1', timestamp: 1000 },
    );
    expect(res.url).toContain('https://cdn/');
    expect(st.uploaded).toHaveLength(1);
    // WAHA media is downloaded with X-Api-Key, not Bearer.
    expect(fetchMock.mock.calls[0][1].headers['X-Api-Key']).toBe('key-1');
    vi.unstubAllGlobals();
  });
});