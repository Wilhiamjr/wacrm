// ============================================================
// WhatsApp provider abstraction — shared types.
//
// wacrm is transport-agnostic at the edges: the business logic
// (contacts, conversations, messages, automations, flows, AI reply)
// talks to a `WhatsAppProvider`, and each provider adapts the
// wire format of a specific backend:
//
//   - `meta`  → Meta Cloud API (graph.facebook.com) — the official
//               WhatsApp Business API. Templates, registration, and
//               Resumable Upload are Meta-only.
//   - `waha`  → WAHA (WhatsApp HTTP API) — a self-hosted REST API
//               that pairs to WhatsApp via QR code. No templates —
//               those fall back to plain text on the caller side.
//
// Everything that differs across providers is normalised here:
//
//   - `NormalizedInboundEvent` — one shape for every webhook event
//     (inbound message, delivery/read status, reaction).
//   - `Send*Params` — one shape per outbound message kind.
//
// The rest of the code never imports meta-api.ts directly; it calls
// the provider interface and lets the factory
// (`./index.ts:getWhatsAppProvider`) pick the implementation based on
// the account's `whatsapp_config.provider`.
// ============================================================

import type {
  InteractiveButton,
  InteractiveListSection,
  MediaKind,
} from '@/lib/whatsapp/meta-api';
import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

export type WhatsAppProviderName = 'meta' | 'waha';

/**
 * Free-form per-provider settings stored on the whatsapp_config row
 * (column `provider_config`, migration 040). For WAHA:
 * `{ baseUrl, apiKey, sessionName }`.
 */
export type ProviderConfig = Record<string, unknown>;

export type InboundEventKind = 'message' | 'status' | 'reaction';

/** Mirror of the `messages.content_type` vocabulary (plus `sticker`). */
export type InboundMessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'document'
  | 'audio'
  | 'sticker'
  | 'location'
  | 'interactive'
  | 'button';

/** Delivery states mapped from provider ACKs onto wacrm's ladder. */
export type InboundStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface NormalizedMedia {
  /**
   * Download URL. Meta providers store the proxy path
   * `/api/whatsapp/media/<id>`; WAHA stores the provider file URL.
   */
  url: string;
  mimeType: string;
  /** Stable provider media id (Meta media id). WAHA events omit it. */
  id?: string;
  caption?: string;
  filename?: string;
}

export interface NormalizedLocation {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface NormalizedInteractive {
  kind: 'button_reply' | 'list_reply';
  /** The stable id we assigned when sending (button id / row id). */
  id: string;
  title: string;
}

export interface NormalizedReaction {
  /** Empty string means the reaction was removed. */
  emoji: string;
  /** Provider message id of the message being reacted to. */
  targetMessageId: string;
}

/**
 * One webhook event, in whatever shape the provider delivered it,
 * normalised to wacrm's canonical vocabulary.
 */
export interface NormalizedInboundEvent {
  kind: InboundEventKind;
  provider: WhatsAppProviderName;
  /**
   * Provider message id — stable within a WhatsApp number, which is the
   * idempotency key for inbound inserts (`(conversation_id, message_id)`
   * UNIQUE, migration 037).
   */
  messageId: string;
  /** Digits-only E.164 without `+` — wacrm's canonical contact phone. */
  phoneNumber: string;
  /** Unix seconds. */
  timestamp: number;
  /** Sender profile name, when the provider reports one. */
  contactName?: string;

  // ---- message event fields ----
  messageType?: InboundMessageKind;
  text?: string;
  media?: NormalizedMedia;
  location?: NormalizedLocation;
  interactive?: NormalizedInteractive;
  /** Provider message id of the message this one replies to. */
  replyToId?: string;

  // ---- status event fields ----
  status?: InboundStatus;

  // ---- reaction event fields ----
  reaction?: NormalizedReaction;
}

// ============================================================
// Outbound params
// ============================================================

export interface SendResult {
  /** Provider-side message id (stored as `messages.message_id`). */
  messageId: string;
}

export interface SendTextParams {
  to: string;
  text: string;
  contextMessageId?: string;
}

export interface SendMediaParams {
  to: string;
  kind: MediaKind;
  /** Public URL the provider fetches at send time. */
  url: string;
  caption?: string;
  filename?: string;
  contextMessageId?: string;
}

export interface SendReactionParams {
  to?: string;
  /** Provider message id of the message being reacted to. */
  targetMessageId: string;
  /** Single emoji, or empty string to remove. */
  emoji: string;
}

export interface SendInteractiveButtonsParams {
  to: string;
  bodyText: string;
  headerText?: string;
  footerText?: string;
  buttons: InteractiveButton[];
  contextMessageId?: string;
}

export interface SendInteractiveListParams {
  to: string;
  bodyText: string;
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  sections: InteractiveListSection[];
  contextMessageId?: string;
}

export interface SendTemplateParams {
  to: string;
  templateName: string;
  language?: string;
  template?: MessageTemplate | null;
  messageParams?: SendTimeParams | null;
  params?: string[];
  contextMessageId?: string;
}

// ============================================================
// Inbound media resolution
// ============================================================

export interface ResolveInboundMediaContext {
  /** Tenant — drives the account-scoped chat-media path. */
  accountId: string;
  /** Meta-style access token, for providers that need one to download. */
  accessToken?: string;
  /** Per-account opt-out for the inbound-media mirror (migration 039). */
  mirrorMedia: boolean;
  messageId: string;
  /** Unix seconds — kept for deterministic object names. */
  timestamp: number;
}

export interface ResolveInboundMediaResult {
  /** Durable URL to persist (chat-media object URL, or a provider proxy). */
  url: string | null;
  mimeType: string | null;
}

// ============================================================
// The provider interface
// ============================================================

export interface WhatsAppProvider {
  readonly name: WhatsAppProviderName;

  // ---- outbound ----
  sendText(params: SendTextParams): Promise<SendResult>;
  sendMedia(params: SendMediaParams): Promise<SendResult>;
  sendReaction(params: SendReactionParams): Promise<void>;
  /** Optional — unsupported providers omit it and callers fall back. */
  sendInteractiveButtons?(
    params: SendInteractiveButtonsParams
  ): Promise<SendResult>;
  sendInteractiveList?(params: SendInteractiveListParams): Promise<SendResult>;
  /** Optional — templates are Meta-only. Callers render text as fallback. */
  sendTemplate?(params: SendTemplateParams): Promise<SendResult>;
  sendSeen?(chatId: string): Promise<void>;
  checkNumber?(phone: string): Promise<{ exists: boolean; chatId: string }>;

  // ---- inbound ----
  /**
   * Parse a provider webhook body into normalised events. Must return
   * an empty array for irrelevant payloads (heartbeats, unowned events…)
   * rather than throwing.
   */
  parseWebhook(
    body: unknown,
    headers?: Record<string, string>
  ): NormalizedInboundEvent[];
  /** Provider webhook signature check. Meta verifies HMAC SHA-256. */
  verifyWebhook?(body: unknown, headers: Record<string, string>): boolean;
  /**
   * Optional — WAHA only. Map a stored phone that is actually a
   * WhatsApp LID (GOWS new format) back to the real phone number so
   * events are persisted under a sendable identifier.
   */
  resolveLidPhone?(phone: string): Promise<string>;

  /**
   * Turn an inbound media reference into a storable URL + MIME type,
   * mirroring into chat-media when `ctx.mirrorMedia` is true.
   */
  resolveInboundMedia(
    media: NormalizedMedia,
    ctx: ResolveInboundMediaContext
  ): Promise<ResolveInboundMediaResult>;

  // ---- health / provisioning ----
  verifyCredentials(): Promise<{ valid: boolean; error?: string }>;
  /**
   * Optional — live session status (WAHA). Providers that pair via QR
   * report their current engine state here so callers can distinguish
   * "server reachable, waiting for scan" from "fully connected".
   */
  getSessionStatus?(): Promise<{ status?: string }>;
}

// ============================================================
// Errors
// ============================================================

/** The provider cannot perform an operation (e.g. templates on WAHA). */
export class ProviderUnsupportedError extends Error {
  readonly operation: string;
  constructor(operation: string, provider: string) {
    super(
      `"${operation}" is not supported by the "${provider}" provider. ` +
        'Switch your WhatsApp configuration back to Meta to use this feature.'
    );
    this.name = 'ProviderUnsupportedError';
    this.operation = operation;
  }
}

/** The provider's configuration is missing or invalid. */
export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

/** Provider credentials were rejected (401 / not working). */
export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}
