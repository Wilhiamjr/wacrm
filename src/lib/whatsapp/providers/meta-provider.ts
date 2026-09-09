// ============================================================
// Meta Cloud API provider.
//
// Adapts the existing `@/lib/whatsapp/meta-api` client to the
// provider interface. All outbound calls delegate to meta-api.ts
// (unchanged); parseWebhook converts Meta's webhook shape to
// `NormalizedInboundEvent`s; resolveInboundMedia mirrors inbound
// attachments into chat-media exactly as the legacy inline webhook did.
// ============================================================

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendReactionMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  getMediaUrl,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import { mirrorInboundMedia, type MirrorStorage } from '@/lib/whatsapp/mirror-inbound-media';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { WhatsAppConfig } from '@/types';
import type {
  NormalizedInboundEvent,
  NormalizedMedia,
  NormalizedReaction,
  ProviderConfig,
  ResolveInboundMediaContext,
  ResolveInboundMediaResult,
  SendInteractiveButtonsParams,
  SendInteractiveListParams,
  SendMediaParams,
  SendReactionParams,
  SendResult,
  SendTemplateParams,
  SendTextParams,
  WhatsAppProvider,
} from './types';

// Meta's webhook envelope (mirrors the route.ts interfaces kept in
// sync — see the load-bearing comment there).
interface MetaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  audio?: { id: string; mime_type: string };
  sticker?: { id: string; mime_type: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { message_id: string; emoji: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { text?: string; payload?: string };
  context?: { id: string };
}

interface MetaStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

export interface MetaProviderOptions {
  /** Decrypted Meta access token (the caller decrypts). */
  accessToken?: string;
  config?: Partial<WhatsAppConfig>;
  providerConfig?: ProviderConfig;
  storage?: MirrorStorage;
}

// Meta delivery/read statuses map one-to-one onto wacrm's ladder.
const META_STATUS_MAP: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

export class MetaCloudProvider implements WhatsAppProvider {
  readonly name = 'meta' as const;

  private readonly accessToken: string;
  private readonly config: Partial<WhatsAppConfig> | null;
  private readonly storage: MirrorStorage;

  constructor(opts: MetaProviderOptions = {}) {
    this.accessToken =
      opts.accessToken ??
      (opts.config?.access_token ? decrypt(opts.config.access_token) : '');
    this.config = opts.config ?? null;
    this.storage = opts.storage ?? defaultMirrorStorage;
  }

  // ---- outbound ----

  async sendText(params: SendTextParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.ensureReady();
    const result = await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: params.to,
      text: params.text,
      contextMessageId: params.contextMessageId,
    });
    return { messageId: result.messageId };
  }

  async sendMedia(params: SendMediaParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.ensureReady();
    const result = await sendMediaMessage({
      phoneNumberId,
      accessToken,
      to: params.to,
      kind: params.kind,
      link: params.url,
      caption: params.caption,
      filename: params.filename,
      contextMessageId: params.contextMessageId,
    });
    return { messageId: result.messageId };
  }

  async sendReaction(params: SendReactionParams): Promise<void> {
    const { phoneNumberId, accessToken } = this.ensureReady();
    await sendReactionMessage({
      phoneNumberId,
      accessToken,
      to: params.to ?? '',
      targetMessageId: params.targetMessageId,
      emoji: params.emoji,
    });
  }

  async sendInteractiveButtons(params: SendInteractiveButtonsParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.ensureReady();
    const result = await sendInteractiveButtons({
      phoneNumberId,
      accessToken,
      to: params.to,
      bodyText: params.bodyText,
      headerText: params.headerText,
      footerText: params.footerText,
      buttons: params.buttons,
      contextMessageId: params.contextMessageId,
    });
    return { messageId: result.messageId };
  }

  async sendInteractiveList(params: SendInteractiveListParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.ensureReady();
    const result = await sendInteractiveList({
      phoneNumberId,
      accessToken,
      to: params.to,
      bodyText: params.bodyText,
      buttonLabel: params.buttonLabel,
      headerText: params.headerText,
      footerText: params.footerText,
      sections: params.sections,
      contextMessageId: params.contextMessageId,
    });
    return { messageId: result.messageId };
  }

  async sendTemplate(params: SendTemplateParams): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.ensureReady();
    const result = await sendTemplateMessage({
      phoneNumberId,
      accessToken,
      to: params.to,
      templateName: params.templateName,
      language: params.language ?? 'en_US',
      template: params.template ?? undefined,
      messageParams: params.messageParams ?? undefined,
      params: params.params ?? [],
      contextMessageId: params.contextMessageId,
    });
    return { messageId: result.messageId };
  }

  // ---- inbound ----

  verifyWebhook(body: unknown, headers: Record<string, string>): boolean {
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    return verifyMetaWebhookSignature(rawBody, headers['x-hub-signature-256'] ?? '');
  }

  parseWebhook(body: unknown): NormalizedInboundEvent[] {
    if (!body || typeof body !== 'object') return [];
    const envelope = body as { entry?: MetaEntry[] };
    if (!Array.isArray(envelope.entry)) return [];

    const events: NormalizedInboundEvent[] = [];
    for (const entry of envelope.entry) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value) continue;

        // Statuses
        for (const status of value.statuses ?? []) {
          const normalized = this.normalizeStatus(status);
          if (normalized) events.push(normalized);
        }

        // Messages
        const messages = value.messages ?? [];
        const contacts = value.contacts ?? [];
        for (let i = 0; i < messages.length; i++) {
          const message = messages[i];
          const contact = contacts[i] ?? contacts[0];
          const normalized = this.normalizeMessage(message, contact);
          if (normalized) events.push(normalized);
        }
      }
    }
    return events;
  }

  async resolveInboundMedia(
    media: NormalizedMedia,
    ctx: ResolveInboundMediaContext,
  ): Promise<ResolveInboundMediaResult> {
    // The proxy path is what the processor persists when mirroring is
    // off — and the fallback when mirroring is on but can't complete.
    const proxyUrl =
      media.url ??
      (media.id ? `/api/whatsapp/media/${media.id}` : null);

    // No Meta media id → nothing to mirror; keep the proxy.
    if (!media.id || !ctx.mirrorMedia) {
      return { url: proxyUrl, mimeType: media.mimeType ?? null };
    }

    try {
      // Mirror into chat-media. Meta CDN URLs are short-lived, so the
      // mirror NOT copy the proxy path: it must fetch the CDN URL from
      // `getMediaUrl` (Bearer token, same as the legacy webhook) to
      // actually reach the bytes.
      const info = await getMediaUrl({ mediaId: media.id, accessToken: this.accessToken });
      const mirrored = await mirrorInboundMedia({
        storage: this.storage,
        accountId: ctx.accountId,
        mediaId: media.id,
        downloadUrl: info.url,
        accessToken: this.accessToken,
        mimeType: media.mimeType,
        // Lets the mirror skip oversized media BEFORE the transfer
        // (mirrorInboundMedia checks against MEDIA_MAX_BYTES).
        fileSize: info.fileSize ?? null,
        fileName: media.filename,
        messageTimestamp: ctx.timestamp,
      });
      return { url: mirrored ?? proxyUrl, mimeType: media.mimeType ?? null };
    } catch (error) {
      console.error(
        `[meta-provider] resolveInboundMedia failed:`,
        error instanceof Error ? error.message : error,
      );
      return { url: null, mimeType: media.mimeType ?? null };
    }
  }

  // ---- health ----

  async verifyCredentials(): Promise<{ valid: boolean; error?: string }> {
    const { phoneNumberId, accessToken } = this.ensureReady();
    try {
      await verifyPhoneNumber({ phoneNumberId, accessToken });
      return { valid: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, error: message };
    }
  }

  // ---- private ----

  private ensureReady(): { phoneNumberId: string; accessToken: string } {
    const phoneNumberId = this.config?.phone_number_id;
    if (!phoneNumberId || !this.accessToken) {
      throw new Error('Meta provider is missing phone_number_id or access_token');
    }
    return { phoneNumberId, accessToken: this.accessToken };
  }

  private normalizeMessage(
    message: MetaMessage | undefined,
    contact: { profile?: { name?: string }; wa_id?: string } | undefined,
  ): NormalizedInboundEvent | null {
    if (!message?.id || !message.from) return null;

    const base = {
      kind: 'message' as const,
      provider: this.name,
      messageId: message.id,
      phoneNumber: normalizePhone(message.from),
      timestamp: parseInt(message.timestamp, 10) || Math.floor(Date.now() / 1000),
      contactName: contact?.profile?.name ?? undefined,
      replyToId: message.context?.id,
    };

    // Reactions are handled by the processor (not a message row).
    if (message.type === 'reaction') {
      const reaction: NormalizedReaction | undefined = message.reaction
        ? {
            emoji: message.reaction.emoji,
            targetMessageId: message.reaction.message_id,
          }
        : undefined;
      return reaction
        ? {
            kind: 'reaction' as const,
            provider: this.name,
            messageId: message.id,
            phoneNumber: base.phoneNumber,
            timestamp: base.timestamp,
            contactName: base.contactName,
            reaction,
          }
        : null;
    }

    switch (message.type) {
      case 'text':
        return { ...base, messageType: 'text', text: message.text?.body };
      case 'image':
        return msgWithMedia(base, {
          url: `/api/whatsapp/media/${message.image?.id}`,
          id: message.image?.id,
          mimeType: message.image?.mime_type ?? 'image/jpeg',
          caption: message.image?.caption,
          filename: undefined,
        });
      case 'video':
        return msgWithMedia(base, {
          url: `/api/whatsapp/media/${message.video?.id}`,
          id: message.video?.id,
          mimeType: message.video?.mime_type ?? 'video/mp4',
          caption: message.video?.caption,
          filename: undefined,
        });
      case 'document':
        return msgWithMedia(base, {
          url: `/api/whatsapp/media/${message.document?.id}`,
          id: message.document?.id,
          mimeType: message.document?.mime_type ?? 'application/octet-stream',
          caption: message.document?.caption,
          filename: message.document?.filename,
        });
      case 'audio':
        return msgWithMedia(base, {
          url: `/api/whatsapp/media/${message.audio?.id}`,
          id: message.audio?.id,
          mimeType: message.audio?.mime_type ?? 'audio/ogg',
          caption: undefined,
          filename: undefined,
        });
      case 'sticker':
        return msgWithMedia(base, {
          url: `/api/whatsapp/media/${message.sticker?.id}`,
          id: message.sticker?.id,
          mimeType: message.sticker?.mime_type ?? 'image/webp',
          caption: undefined,
          filename: undefined,
        });
      case 'location':
        if (message.location) {
          return {
            ...base,
            messageType: 'location',
            location: {
              latitude: message.location.latitude,
              longitude: message.location.longitude,
              name: message.location.name,
              address: message.location.address,
            },
            text: [message.location.name, message.location.address, `${message.location.latitude},${message.location.longitude}`]
              .filter(Boolean)
              .join(' - ') || undefined,
          };
        }
        return null;
      case 'interactive': {
        const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
        if (reply) {
          return {
            ...base,
            messageType: 'interactive',
            interactive: {
              kind: message.interactive?.type ?? 'button_reply',
              id: reply.id,
              title: reply.title,
            },
            text: reply.title,
          };
        }
        return { ...base, messageType: 'interactive', text: '[Interactive reply]' };
      }
      case 'button':
        return {
          ...base,
          messageType: 'button',
          interactive: {
            kind: 'button_reply',
            id: message.button?.payload || message.button?.text || '',
            title: message.button?.text || message.button?.payload || '',
          },
          text: message.button?.text || message.button?.payload || undefined,
        };
      default:
        return {
          ...base,
          messageType: message.type as NormalizedInboundEvent['messageType'],
          text: `[Unsupported message type: ${message.type}]`,
        };
    }
  }

  private normalizeStatus(status: MetaStatus): NormalizedInboundEvent | null {
    const mapped = META_STATUS_MAP[status.status];
    if (!mapped) return null;
    return {
      kind: 'status',
      provider: this.name,
      messageId: status.id,
      phoneNumber: normalizePhone(status.recipient_id),
      timestamp: parseInt(status.timestamp, 10) || Math.floor(Date.now() / 1000),
      status: mapped,
    };
  }
}

function msgWithMedia(
  base: Omit<NormalizedInboundEvent, 'provider' | 'kind'> & {
    provider: 'meta';
    kind: 'message';
  },
  media: NormalizedMedia,
): NormalizedInboundEvent {
  return {
    ...base,
    messageType: media.id ? inferMessageKind(media) : undefined,
    media,
    text: media.caption ?? undefined,
  };
}

function inferMessageKind(media: NormalizedMedia): NormalizedInboundEvent['messageType'] {
  if (media.mimeType.startsWith('image/')) return 'image';
  if (media.mimeType.startsWith('video/')) return 'video';
  if (media.mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

interface MetaEntry {
  id: string;
  changes: Array<{
    field?: string;
    value?: {
      messaging_product?: string;
      metadata?: Record<string, unknown>;
      contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
      messages?: MetaMessage[];
      statuses?: MetaStatus[];
    };
  }>;
}

// The default, real storage surface. Tests inject a fake.
const defaultMirrorStorage: MirrorStorage = {
  from(bucket: string) {
    throw new Error(
      `MirrorStorage not injected — construct MetaCloudProvider with { storage } in tests (bucket "${bucket}").`,
    );
  },
};