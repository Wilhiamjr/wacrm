// ============================================================
// WAHA provider — WhatsApp HTTP API (self-hosted REST).
//
// Pairs to a WhatsApp account via QR code (or a paired link) and
// exposes a REST API plus event webhooks. Everything the CRM needs
// maps cleanly onto it; the one notable gap is message templates,
// which are exclusive to the official Meta Business API — WAHA sends
// as a regular WhatsApp user, so `sendTemplate` is deliberately NOT
// implemented here. Callers detect that (via the optional-method
// shape) and fall back to rendering the template body as plain text.
//
// Endpoints (WAHA docs — https://waha.devlike.pro):
//   POST /api/sendText            { session, chatId, text, reply_to }
//   POST /api/sendImage           { session, chatId, file, caption }
//   POST /api/sendVideo           { session, chatId, file, caption, convert }
//   POST /api/sendVoice           { session, chatId, file, convert }
//   POST /api/sendFile            { session, chatId, file, caption }
//   POST /api/sendButtons         { session, chatId, ...buttons } (fragile)
//   POST /api/sendList            { session, chatId, message }
//   PUT  /api/reaction            { session, messageId, reaction }
//   POST /api/sendSeen            { session, chatId }
//   GET  /api/contacts/check-exists?phone=&session=
//   GET  /api/sessions/{name}
//   POST /api/sessions            { name, start, config:{ webhooks } }
//
// Auth: every request carries an `X-Api-Key` header.
// ============================================================

import crypto from 'crypto';
import {
  mirrorInboundMedia,
  type MirrorStorage,
} from '@/lib/whatsapp/mirror-inbound-media';
import type {
  NormalizedInboundEvent,
  NormalizedMedia,
  ProviderConfig,
  ResolveInboundMediaContext,
  ResolveInboundMediaResult,
  SendInteractiveButtonsParams,
  SendInteractiveListParams,
  SendMediaParams,
  SendReactionParams,
  SendResult,
  SendTextParams,
  WhatsAppProvider,
} from './types';

export interface WahaConfig {
  /** e.g. https://waha.example.com */
  baseUrl: string;
  /** X-Api-Key for the WAHA instance. */
  apiKey: string;
  /** Session name owning the connected WhatsApp account (default "default"). */
  sessionName?: string;
  /** Secret used to HMAC-sign webhook payloads (sha256) and to verify them. */
  webhookSecret?: string;
}

export interface WahaProviderOptions {
  providerConfig?: ProviderConfig;
  storage?: MirrorStorage;
}

interface WahaSessionInfo {
  name?: string;
  status?: string;
  me?: { id?: string; pushName?: string } | null;
}

interface WahaOk {
  ok?: boolean;
  status?: number;
  message?: string;
}

// WAHA ACK ladder → wacrm's status vocabulary.
const ACK_TO_STATUS: Record<number, 'sent' | 'delivered' | 'read' | 'failed'> = {
  1: 'sent', // SERVER — first tick
  2: 'delivered', // DEVICE — second tick
  3: 'read', // READ — blue ticks
  4: 'read', // PLAYED — voice note playback
};

const DEFAULT_SESSION = 'default';

/** Strip `@c.us` / `@lid` / `@s.whatsapp.net` and return digits only. */
export function wahaChatIdToPhone(chatId: string): string {
  if (!chatId) return '';
  return chatId.split('@')[0].replace(/\D/g, '');
}

/** digits-only E.164 → WAHA chatId (`5511987654321@c.us`). */
export function phoneToWahaChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`;
}

/**
 * WhatsApp's LID (Linked ID) rollout: GOWS delivers new-format senders
 * as `LID@s.whatsapp.net` (or `LID@lid`). Those identifiers are 14+
 * digit numbers that are NOT phone numbers, and sends against them fail
 * with "no LID found for…". Anything at/above this length is treated as
 * a LID candidate and mapped to the real phone via WAHA's `/lids` API.
 */
export const LID_DIGITS_THRESHOLD = 14;

/** True when a stored phone / chatId is likely a WhatsApp LID, not a phone. */
export function isLikelyLidPhone(phoneOrChatId: string): boolean {
  const digits = (phoneOrChatId ?? '').replace(/\D/g, '');
  return digits.length >= LID_DIGITS_THRESHOLD;
}

/**
 * Classify a WAHA webhook `event` into our event kind, or null when
 * the event is irrelevant to the CRM.
 */
export function wahaEventKind(
  event: string,
): NormalizedInboundEvent['kind'] | null {
  switch (event) {
    case 'message':
      return 'message';
    case 'message.ack':
      return 'status';
    case 'message.reaction':
      return 'reaction';
    default:
      return null;
  }
}

export class WahaProvider implements WhatsAppProvider {
  readonly name = 'waha' as const;
  private readonly cfg: WahaConfig;
  private readonly storage: MirrorStorage;

  constructor(opts: WahaProviderOptions) {
    const pc = opts.providerConfig ?? {};
    if (typeof pc.baseUrl !== 'string' || !pc.baseUrl) {
      throw new Error(
        'WAHA provider requires provider_config.baseUrl (e.g. http://localhost:3000).',
      );
    }
    if (typeof pc.apiKey !== 'string') {
      throw new Error('WAHA provider requires provider_config.apiKey.');
    }
    this.cfg = {
      baseUrl: pc.baseUrl.replace(/\/+$/, ''),
      apiKey: pc.apiKey,
      sessionName: (pc.sessionName as string) || DEFAULT_SESSION,
      webhookSecret: (pc.webhookSecret as string) || '',
    };
    this.storage = opts.storage ?? defaultMirrorStorage;
  }

  // ---- outbound ----

  /**
   * Resolve a stored phone to the chatId WAHA can send to. When the
   * value is actually a WhatsApp LID (GOWS new format — see
   * `isLikelyLidPhone`), ask WAHA for the linked phone number
   * (`GET /api/{session}/lids/{lid}`) and send to that instead; WAHA
   * answers `{ pn: "5562…@c.us" }`. Anything else keeps the `@c.us`
   * path (or falls back to it if the LID lookup fails).
   */
  private async resolveSendChatId(to: string): Promise<string> {
    const digits = to.replace(/\D/g, '');
    if (digits.length >= LID_DIGITS_THRESHOLD) {
      try {
        const res = await this.get<{ pn?: string }>(this.lidPath(digits));
        const pn = typeof res?.pn === 'string' ? res.pn : '';
        if (pn) return pn.includes('@') ? pn : `${pn}@c.us`;
      } catch {
        // Not a known LID — fall through to the phone-based chatId.
      }
    }
    return phoneToWahaChatId(digits);
  }

  /** Public: resolve a stored phone that is actually a LID to its digits. */
  async resolveLidPhone(phoneOrChatId: string): Promise<string> {
    const digits = (phoneOrChatId ?? '').replace(/\D/g, '');
    if (digits.length < LID_DIGITS_THRESHOLD) return digits;
    try {
      const res = await this.get<{ pn?: string }>(this.lidPath(digits));
      if (res?.pn) return wahaChatIdToPhone(res.pn);
    } catch {
      // Not a known LID.
    }
    return digits;
  }

  private lidPath(lidDigits: string): string {
    const session = this.cfg.sessionName || DEFAULT_SESSION;
    return `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(
      lidDigits,
    )}`;
  }

  async sendText(params: SendTextParams): Promise<SendResult> {
    const body: Record<string, unknown> = {
      session: this.cfg.sessionName,
      chatId: await this.resolveSendChatId(params.to),
      text: params.text,
    };
    if (params.contextMessageId) body.reply_to = params.contextMessageId;
    const data = await this.post('/api/sendText', body);
    return { messageId: messageIdFromWaha(data, params.to) };
  }

  async sendMedia(params: SendMediaParams): Promise<SendResult> {
    if (!params.url) throw new Error('WAHA sendMedia requires a url.');

    // WAHA's audio path expects OGG/Opus; request conversion for
    // anything else so a downloaded voice note actually plays.
    if (params.kind === 'audio') {
      const data = await this.post('/api/sendVoice', {
        session: this.cfg.sessionName,
        chatId: await this.resolveSendChatId(params.to),
        file: { url: params.url },
        convert: true,
      });
      return { messageId: messageIdFromWaha(data, params.to) };
    }

    const endpoint =
      params.kind === 'image'
        ? '/api/sendImage'
        : params.kind === 'video'
          ? '/api/sendVideo'
          : '/api/sendFile';

    const data = await this.post(endpoint, {
      session: this.cfg.sessionName,
      chatId: await this.resolveSendChatId(params.to),
      file: { url: params.url, filename: params.filename ?? undefined },
      caption: params.caption ?? undefined,
      convert: params.kind === 'video',
    });
    return { messageId: messageIdFromWaha(data, params.to) };
  }

  async sendReaction(params: SendReactionParams): Promise<void> {
    // NOTE: WAHA uses PUT, not POST, for reactions — easy to miss.
    await this.put('/api/reaction', {
      session: this.cfg.sessionName,
      messageId: params.targetMessageId,
      reaction: params.emoji || '',
    });
  }

  async sendInteractiveButtons(params: SendInteractiveButtonsParams): Promise<SendResult> {
    // sendButtons is documented as fragile; keep the payload minimal.
    const data = await this.post('/api/sendButtons', {
      session: this.cfg.sessionName,
      chatId: await this.resolveSendChatId(params.to),
      body: params.bodyText,
      footer: params.footerText ?? undefined,
      buttons: params.buttons.map((b) => ({ type: 'reply', text: b.title })),
    });
    return { messageId: messageIdFromWaha(data, params.to) };
  }

  async sendInteractiveList(params: SendInteractiveListParams): Promise<SendResult> {
    const data = await this.post('/api/sendList', {
      session: this.cfg.sessionName,
      chatId: await this.resolveSendChatId(params.to),
      message: {
        title: params.headerText ?? params.bodyText,
        description: params.bodyText,
        button: params.buttonLabel,
        sections: params.sections.map((s) => ({
          title: s.title ?? undefined,
          rows: s.rows.map((r) => ({
            title: r.title,
            rowId: r.id,
            description: r.description ?? undefined,
          })),
        })),
      },
    });
    return { messageId: messageIdFromWaha(data, params.to) };
  }

  async sendSeen(chatId: string): Promise<void> {
    await this.post('/api/sendSeen', {
      session: this.cfg.sessionName,
      chatId: await this.resolveSendChatId(chatId),
    });
  }

  async checkNumber(phone: string): Promise<{ exists: boolean; chatId: string }> {
    const params = new URLSearchParams({ phone: phone.replace(/\D/g, '') });
    if (this.cfg.sessionName) params.set('session', this.cfg.sessionName);
    const data = await this.get(`/api/contacts/check-exists?${params.toString()}`);
    return {
      exists: Boolean(data?.numberExists),
      chatId:
        typeof data?.chatId === 'string'
          ? data.chatId
          : wahaChatIdToPhone(phoneToWahaChatId(phone)),
    };
  }

  // ---- inbound ----

  verifyWebhook(body: unknown, headers: Record<string, string>): boolean {
    const signature = headers['x-webhook-hmac'] ?? '';
    if (!signature || !this.cfg.webhookSecret) {
      // No secret configured → the webhook wasn't chained to a session
      // we provisioned. Fail closed rather than accept unsigned payloads.
      return false;
    }
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const expected = crypto
      .createHmac('sha512', this.cfg.webhookSecret)
      .update(rawBody)
      .digest('hex');
    // Tolerate both bare hex and the algorithm-prefixed form.
    const normalized = signature.replace(/^sha512=/, '').toLowerCase();
    return crypto.timingSafeEqual(
      Buffer.from(normalized),
      Buffer.from(expected),
    );
  }

  parseWebhook(body: unknown): NormalizedInboundEvent[] {
    if (!body || typeof body !== 'object') return [];
    const envelope = body as { event?: string; payload?: Record<string, unknown> };
    const kind = wahaEventKind(envelope.event ?? '');
    if (!kind) return [];
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    switch (kind) {
      case 'message': {
        const msg = this.normalizeMessage(payload);
        return msg ? [msg] : [];
      }
      case 'status': {
        const st = this.normalizeStatus(payload);
        return st ? [st] : [];
      }
      case 'reaction': {
        const re = this.normalizeReaction(payload);
        return re ? [re] : [];
      }
    }
  }

  async resolveInboundMedia(
    media: NormalizedMedia,
    ctx: ResolveInboundMediaContext,
  ): Promise<ResolveInboundMediaResult> {
    try {
      if (ctx.mirrorMedia) {
        const mirrored = await mirrorInboundMedia({
          storage: this.storage,
          accountId: ctx.accountId,
          mediaId: media.id ?? `incoming-${ctx.messageId}`,
          downloadUrl: media.url,
          accessToken: '', // unused — WAHA uses X-Api-Key instead
          mimeType: media.mimeType,
          fileSize: null,
          fileName: media.filename,
          messageTimestamp: ctx.timestamp,
          // WAHA's media endpoint authenticates with X-Api-Key, not
          // Meta's Bearer — inject a WAHA downloader.
          download: async ({ downloadUrl }) => this.download(downloadUrl),
        });
        if (mirrored) {
          return { url: mirrored, mimeType: media.mimeType ?? null };
        }
      }
      // No mirror (disabled) → keep the WAHA file URL so the proxy
      // still works for the bucket lifetime.
      return { url: media.url, mimeType: media.mimeType ?? null };
    } catch (error) {
      console.error(
        '[waha-provider] resolveInboundMedia failed:',
        error instanceof Error ? error.message : error,
      );
      return { url: media.url, mimeType: media.mimeType ?? null };
    }
  }

  // ---- health / provisioning ----

  /**
   * Validate the WAHA credentials (reachability + API key) WITHOUT
   * requiring the named session to exist yet. A fresh session is
   * provisioned by `configureSession`, so probing the session's own
   * endpoint would 404 for a brand-new setup and wrongly fail the
   * connect. The sessions list answers 401 for a bad api key and does
   * not depend on any particular session existing.
   */
  async verifyCredentials(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.get('/api/sessions');
      return { valid: true };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getSessionStatus(): Promise<WahaSessionInfo> {
    return this.get(`/api/sessions/${encodeURIComponent(this.cfg.sessionName!)}`);
  }

  /**
   * Provision a session wired to our webhook endpoint. Creates the
   * session (start: false → STOPPED, so the operator scans the QR via
   * WAHA) and attaches the event webhook that delivers `message`,
   * `message.ack` and `message.reaction` payloads to the given URL.
   */
  async configureSession(options: {
    webhookUrl: string;
    webhookSecret: string;
  }): Promise<WahaSessionInfo> {
    const existing = await this.getSessionStatus().catch(() => null);

    const config = {
      webhooks: [
        {
          url: options.webhookUrl,
          events: ['message', 'message.ack', 'message.reaction', 'session.status'],
          hmac: { key: options.webhookSecret },
          retries: { policy: 'constant', delaySeconds: 2, attempts: 8 },
        },
      ],
    };

    if (existing?.status && existing.status !== 'STOPPED' && existing.status !== 'FAILED') {
      // Silently stop so the config can be rewritten without a
      // "session already running" error; WAHA restarts it automatically.
      await this.post(
        `/api/sessions/${encodeURIComponent(this.cfg.sessionName!)}/stop`,
        {},
      ).catch(() => undefined);
    }

    if (existing) {
      // Update an existing session's config.
      await this.put(`/api/sessions/${encodeURIComponent(this.cfg.sessionName!)}`, {
        name: this.cfg.sessionName,
        start: false,
        config,
      });
    } else {
      // Brand-new session: WAHA core only CREATES via POST /api/sessions —
      // a PUT 404s for a session that doesn't exist yet.
      await this.post('/api/sessions', {
        name: this.cfg.sessionName,
        start: false,
        config,
      });
    }

    await this.post(
      `/api/sessions/${encodeURIComponent(this.cfg.sessionName!)}/start`,
      {},
    ).catch(() => undefined);

    return this.getSessionStatus().catch(() => ({}));
  }

  // ---- private HTTP plumbing ----

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Api-Key': this.cfg.apiKey,
    };
  }

  private async get<T = Record<string, unknown>>(path: string): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      headers: { 'X-Api-Key': this.cfg.apiKey },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw this.errorFrom(res, 'GET', path);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  private async post<T = WahaOk>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      throw this.errorFrom(res, 'POST', path);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  private async put<T = WahaOk>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      throw this.errorFrom(res, 'PUT', path);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  private errorFrom(res: Response, method: string, path: string): Error {
    return new Error(
      `WAHA ${method} ${path} failed (${res.status}): ${res.statusText || res.status}`,
    );
  }

  private async download(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await fetch(url, {
      headers: { 'X-Api-Key': this.cfg.apiKey },
    });
    if (!res.ok) {
      throw new Error(`WAHA media download failed (${res.status})`);
    }
    const contentType =
      res.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  }

  // ---- normalisation ----

  private normalizeMessage(payload: Record<string, unknown>): NormalizedInboundEvent {
    const id = typeof payload.id === 'string' ? payload.id : '';
    const from = typeof payload.from === 'string' ? payload.from : '';
    const ts = toSeconds(payload.timestamp);

    const base = {
      kind: 'message' as const,
      provider: this.name,
      messageId: id,
      phoneNumber: wahaChatIdToPhone(from),
      timestamp: ts,
      replyToId:
        payload.replyTo && typeof (payload.replyTo as { id?: unknown }).id === 'string'
          ? (payload.replyTo as { id: string }).id
          : undefined,
    };

    const media = payload.hasMedia
      ? (payload.media as { url?: string; mimetype?: string; filename?: string } | null)
      : null;

    if (media?.url) {
      const url = media.url;
      const mimeType = media.mimetype ?? 'application/octet-stream';
      if (mimeType.startsWith('image/')) {
        return {
          ...base,
          messageType: mimeType === 'image/webp' ? 'sticker' : 'image',
          media: { url, mimeType, caption: media.filename, filename: media.filename },
          text: media.filename,
        };
      }
      if (mimeType.startsWith('video/')) {
        return {
          ...base,
          messageType: 'video',
          media: { url, mimeType, caption: media.filename, filename: media.filename },
          text: media.filename,
        };
      }
      if (mimeType.startsWith('audio/')) {
        return {
          ...base,
          messageType: 'audio',
          media: { url, mimeType, filename: media.filename },
        };
      }
      return {
        ...base,
        messageType: 'document',
        media: { url, mimeType, caption: media.filename, filename: media.filename },
        text: media.filename,
      };
    }

    const body = typeof payload.body === 'string' ? payload.body : '';
    if (body) {
      return { ...base, messageType: 'text', text: body };
    }

    return { ...base, messageType: 'text', text: '[Unsupported message type]' };
  }

  private normalizeStatus(payload: Record<string, unknown>): NormalizedInboundEvent | null {
    const id = typeof payload.id === 'string' ? payload.id : '';
    if (!id) return null;
    const ack = typeof payload.ack === 'number' ? payload.ack : Number(payload.ack);
    const status = ACK_TO_STATUS[ack];
    if (!status) return null;
    const from = typeof payload.from === 'string' ? payload.from : '';
    return {
      kind: 'status',
      provider: this.name,
      messageId: id,
      phoneNumber: wahaChatIdToPhone(from),
      timestamp: toSeconds(payload.timestamp),
      status,
    };
  }

  private normalizeReaction(payload: Record<string, unknown>): NormalizedInboundEvent | null {
    const id = typeof payload.id === 'string' ? payload.id : '';
    const from = typeof payload.from === 'string' ? payload.from : '';
    const reaction = payload.reaction as { text?: string; messageId?: string } | null;
    if (!reaction?.messageId) return null;
    return {
      kind: 'reaction',
      provider: this.name,
      messageId: id,
      phoneNumber: wahaChatIdToPhone(from),
      timestamp: toSeconds(payload.timestamp),
      reaction: {
        emoji: typeof reaction.text === 'string' ? reaction.text : '',
        targetMessageId: reaction.messageId,
      },
    };
  }
}

function messageIdFromWaha(data: unknown, to: string): string {
  const id = (data as { id?: string } | null)?.id;
  // WAHA echoes the WhatsApp message id directly; if absent we fake a
  // stable-enough local id so status webhooks can still correlate.
  return id || `waha:${to.replace(/\D/g, '')}:${Date.now()}`;
}

/** WAHA timestamps arrive in seconds (message) or ms (event); handle both. */
function toSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return Math.floor(Date.now() / 1000);
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

const defaultMirrorStorage: MirrorStorage = {
  from(bucket: string) {
    throw new Error(
      `MirrorStorage not injected — provide { storage } in tests (bucket "${bucket}").`,
    );
  },
};