// ============================================================
// Normalized-event webhook processor.
//
// The single pipeline that turns `NormalizedInboundEvent`s (the
// provider-independent shape produced by `parseWebhook`) into CRM
// state. Both webhook routes — Meta (`/api/whatsapp/webhook`) and
// WAHA (`/api/whatsapp/waha/webhook`) — resolve their account's
// provider, parse the raw payload into events, then hand them here.
//
// Responsibilities covered in this one place so the two routes can't
// drift apart:
//   - message events  → contact/conversation creation, media mirror,
//                       message insert (idempotent), conversation bump
//                       + reopen, broadcast-reply flag, flows /
//                       automations / AI reply dispatch, public webhook.
//   - reaction events → message_reactions upsert/delete (never a
//                       `messages` row, never an unread bump).
//   - status events   → messages + broadcast_recipients ladder with
//                       forward-only transitions, then webhook fan-out.
//
// Template-lifecycle events (Meta-only, different change.field) do NOT
// arrive here — the Meta route intercepts them before parsing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import type {
  NormalizedInboundEvent,
  WhatsAppProvider,
} from './providers/types'

export interface WebhookProcessingContext {
  /** Service-role client — every write here bypasses RLS. */
  supabase: SupabaseClient
  /** Provider already built for the account that owns these events. */
  provider: WhatsAppProvider
  /** Tenant — every contact / conversation / message row is stamped. */
  accountId: string
  /** Audit sender-of-record — the admin who saved the WhatsApp config. */
  configOwnerUserId: string
  /** Per-account opt-out for the inbound-media mirror (migration 039). */
  mirrorMedia: boolean
}

/**
 * Process delivered events. Never throws — a webhook must always
 * 200-ack the provider; the routes wrap the call in `after()`.
 */
export async function processNormalizedEvents(
  ctx: WebhookProcessingContext,
  events: NormalizedInboundEvent[],
): Promise<void> {
  for (const event of events) {
    try {
      switch (event.kind) {
        case 'status':
          await handleStatusUpdate(ctx, event)
          break
        case 'message':
          await processMessage(ctx, event)
          break
        case 'reaction':
          await processReaction(ctx, event)
          break
      }
    } catch (error) {
      console.error(
        '[webhook-processor] event failed:',
        error instanceof Error ? error.message : error,
      )
    }
  }
}

// ============================================================
// Status events
// ============================================================

/**
 * The happy-path status ladder — pending → sent → delivered → read →
 * replied. Webhook replays must never regress a recipient back down
 * this ladder.
 *
 * `failed` is NOT on this ladder. It's a terminal side branch that is
 * only valid from the early states (pending / sent) — once a number has
 * delivered or the user has read or replied, a later "failed" status
 * event is a bug in the provider's pipeline or a spoof attempt.
 */
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
export function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(ctx: WebhookProcessingContext, event: NormalizedInboundEvent) {
  const status = event.status
  if (!status) return
  const messageId = event.messageId

  // 1) Mirror onto messages (legacy behavior) — the provider's mapped
  //    status values already match the CHECK constraint on
  //    messages.status. No `.select()`: message_id is NOT unique
  //    (migration 009 — provider ids repeat across numbers), so this
  //    updates 0..N rows and must not assume a single row.
  const { error: msgErr } = await ctx.supabase
    .from('messages')
    .update({ status })
    .eq('message_id', messageId)

  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (migration 003). The aggregate trigger re-derives the parent
  //    broadcast's sent/delivered/read/failed counts automatically.
  const tsIso = new Date(event.timestamp * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await ctx.supabase
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', messageId)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status)
  ) {
    const update: Record<string, unknown> = { status }
    if (status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status === 'delivered') update.delivered_at = tsIso
    if (status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await ctx.supabase
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await ctx.supabase
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', messageId)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = (msgRow.conversations as unknown as { account_id: string } | null)
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(ctx.supabase, accountId, 'message.status_updated', {
        whatsapp_message_id: messageId,
        conversation_id: msgRow.conversation_id,
        status,
      })
    }
  }
}

// ============================================================
// Reactions
// ============================================================

/**
 * Resolve a provider-side message_id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalId(ctx: WebhookProcessingContext, providerId: string, conversationId: string): Promise<string | null> {
  const { data, error } = await ctx.supabase
    .from('messages')
    .select('id')
    .eq('message_id', providerId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook-processor] lookupInternalId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200.
 */
async function persistReaction(
  ctx: WebhookProcessingContext,
  event: NormalizedInboundEvent,
  conversationId: string,
  contactId: string,
) {
  const reaction = event.reaction
  if (!reaction?.targetMessageId) return

  const targetInternalId = await lookupInternalId(ctx, reaction.targetMessageId, conversationId)
  if (!targetInternalId) {
    console.warn(
      '[webhook-processor] reaction target message not found; skipping',
      reaction.targetMessageId,
    )
    return
  }

  // Empty emoji = removal (per the Meta Cloud API spec; WAHA mirrors it).
  if (!reaction.emoji) {
    const { error: delError } = await ctx.supabase
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook-processor] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await ctx.supabase
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' },
    )
  if (upsertError) {
    console.error('[webhook-processor] reaction upsert failed:', upsertError.message)
  }
}

// ============================================================
// Contact / conversation
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created. */
  wasCreated: boolean
}

async function findOrCreateContact(
  ctx: WebhookProcessingContext,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(ctx.supabase, ctx.accountId, phone)

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await ctx.supabase
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column; user_id is the
  // NOT NULL FK audit column (no inbound message has a single "user who
  // created" it — we attribute to the WhatsApp config owner).
  const { data: newContact, error: createError } = await ctx.supabase
    .from('contacts')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(ctx.supabase, ctx.accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  ctx: WebhookProcessingContext,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()`. `.single()` errors on *both*
  // 0 rows and ≥2 rows, and the old code treated any error as "none
  // found" and inserted a new row. So once two conversations existed for
  // a contact (from a race), every subsequent inbound message errored on
  // the lookup and created yet another conversation, snowballing into a
  // wall of duplicate chats (issue #363). Ordering oldest-first and
  // taking one row makes the lookup resolve to the same canonical
  // survivor the dedup migration (036) keeps.
  const { data: existingRows, error: findError } = await ctx.supabase
    .from('conversations')
    .select('*')
    .eq('account_id', ctx.accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await ctx.supabase
    .from('conversations')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await ctx.supabase
        .from('conversations')
        .select('*')
        .eq('account_id', ctx.accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * Resolve the tenant's contact + conversation for an inbound event,
 * emitting `conversation.created` when the thread is first opened.
 * Returns null (event skipped, webhook still 200s) when a row can't be
 * found or created.
 */
async function ensureThread(
  ctx: WebhookProcessingContext,
  event: NormalizedInboundEvent,
): Promise<{ contact: ContactRow; conversation: { id: string }; wasCreated: boolean } | null> {
  const contactOutcome = await findOrCreateContact(
    ctx,
    event.phoneNumber,
    event.contactName ?? '',
  )
  if (!contactOutcome) return null
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(ctx, contactRecord.id)
  if (!convResult) return null
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(ctx.supabase, ctx.accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  return { contact: contactRecord, conversation, wasCreated: contactOutcome.wasCreated }
}

// ============================================================
// Inbound messages
// ============================================================

/**
 * If an inbound message's sender sits on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort — failures must not
 * break the main inbound flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(ctx: WebhookProcessingContext, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't been
    // replied to yet. Account-scoped so a shared inbox reply marks the
    // broadcast as replied regardless of which teammate sent it.
    const { data: recs, error } = await ctx.supabase
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', ctx.accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await ctx.supabase
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Map the provider's message-kind vocabulary onto the
 * `messages.content_type` CHECK constraint (widened in migration 010 to
 * add 'interactive'): text/image/document/audio/video/location/template/
 * interactive. `sticker` and `button` aren't in that list — the closest
 * allowed values are 'image' and 'interactive'.
 */
function mapContentType(messageType: NormalizedInboundEvent['messageType']): string {
  switch (messageType) {
    case 'text':
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'location':
      return messageType
    case 'sticker':
      return 'image' // stickers are images
    case 'interactive':
    case 'button':
      return 'interactive' // template quick-reply tap (issue #478)
    default:
      return 'text'
  }
}

async function processReaction(ctx: WebhookProcessingContext, event: NormalizedInboundEvent) {
  const thread = await ensureThread(ctx, event)
  if (!thread) return
  await persistReaction(ctx, event, thread.conversation.id, thread.contact.id)
}

async function processMessage(ctx: WebhookProcessingContext, event: NormalizedInboundEvent) {
  const thread = await ensureThread(ctx, event)
  if (!thread) return
  const { contact: contactRow, conversation } = thread

  // Parse message content based on the normalised event. Media
  // resolution (the provider-specific chunk: Meta verifies + mirrors via
  // getMediaUrl; WAHA downloads with X-Api-Key) happens here.
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseEventContent(ctx, event)

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (event.replyToId) {
    replyToInternalId = await lookupInternalId(ctx, event.replyToId, conversation.id)
    if (!replyToInternalId) {
      console.warn(
        '[webhook-processor] reply context parent not found:',
        event.replyToId,
      )
    }
  }

  const contentType = mapContentType(event.messageType)

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await ctx.supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert. Providers retry webhook deliveries (a slow ack, a
  // transient 5xx), and each retry replays the exact same message id. The
  // unique index on (conversation_id, message_id) added in migration 037
  // makes a replay conflict; `ignoreDuplicates` turns that into an ON
  // CONFLICT DO NOTHING, and the `.select()` then returns the inserted row
  // ONLY on a genuine first insert. This is the single idempotency
  // boundary that must sit BEFORE the unread bump and all downstream
  // fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await ctx.supabase
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        // Provider MIME type for the attachment (migration 039).
        media_type: mediaType,
        message_id: event.messageId,
        status: 'delivered',
        created_at: new Date(event.timestamp * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        // Only populated for content_type='interactive' (migration 010).
        interactive_reply_id: interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Replayed delivery: the message already exists, so acknowledge it as a
  // no-op. Returning here keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling,
  // and re-dispatching public webhooks (issue #367).
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[webhook-processor] duplicate inbound message ignored (idempotent replay):',
      event.messageId,
    )
    return
  }

  // Update conversation. The unread bump is done DB-side (migration 037's
  // bump_conversation_on_inbound) — two inbound messages for the same
  // conversation can process concurrently, and computing `snapshot + 1`
  // in the app lost one increment (issue #369).
  const { error: convError } = await ctx.supabase.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || `[${event.messageType ?? 'message'}]`,
  })

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409).
  await reopenClosedConversation(ctx.supabase, conversation)

  // If this contact was a recent broadcast recipient, flag the reply so
  // the broadcast's `replied_count` advances (migration 003 trigger).
  await flagBroadcastReplyIfAny(ctx, contactRow.id)

  // ============================================================
  // Flow runner dispatch. If the runner consumes the message (it either
  // advanced an active run or started a new one), suppress the
  // `new_message_received` + `keyword_match` automation triggers —
  // the customer is navigating the bot menu, not sending a fresh trigger
  // word. The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed.
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId: ctx.accountId,
    userId: ctx.configOwnerUserId,
    contactId: contactRow.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: event.messageId,
        }
      : {
          kind: 'text',
          text: contentText ?? event.text ?? '',
          meta_message_id: event.messageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  const inboundText = contentText ?? event.text ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (thread.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  // Awaited — not fire-and-forget: we're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see.
  // `runAutomationsForTrigger` owns its own try/catch and never throws.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId: ctx.accountId,
      triggerType,
      contactId: contactRow.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId: ctx.accountId,
      conversationId: conversation.id,
      contactId: contactRow.id,
      configOwnerUserId: ctx.configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited — same `after()`
  // reason as the automation dispatch.
  await dispatchWebhookEvent(ctx.supabase, ctx.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRow.id,
    whatsapp_message_id: event.messageId,
    content_type: contentType,
    text: contentText,
  })
}

/**
 * Derive the persistent message content from an event. For media events
 * the provider resolves the download + mirror (Meta verifies with
 * getMediaUrl, WAHA downloads with X-Api-Key) via
 * `provider.resolveInboundMedia`.
 */
async function parseEventContent(
  ctx: WebhookProcessingContext,
  event: NormalizedInboundEvent,
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  interactiveReplyId: string | null
}> {
  const empty = () => ({
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  })

  const media = event.media
  if (media?.url) {
    const resolved = await ctx.provider.resolveInboundMedia(
      { ...media, mimeType: media.mimeType },
      {
        accountId: ctx.accountId,
        mirrorMedia: ctx.mirrorMedia,
        messageId: event.messageId,
        timestamp: event.timestamp,
      },
    )
    return {
      contentText: event.text ?? null,
      mediaUrl: resolved.url,
      mediaType: resolved.mimeType ?? media.mimeType ?? null,
      interactiveReplyId: event.interactive?.id ?? null,
    }
  }

  if (event.messageType === 'location' && event.location) {
    const loc = event.location
    const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
      .filter(Boolean)
      .join(' - ')
    return { ...empty(), contentText: locationText }
  }

  if (event.messageType === 'interactive' || event.messageType === 'button') {
    const reply = event.interactive
    if (reply?.id) {
      return {
        ...empty(),
        contentText: reply.title || reply.id,
        interactiveReplyId: reply.id,
      }
    }
    return { ...empty(), contentText: '[Interactive reply]' }
  }

  if (event.messageType === 'text') {
    return { ...empty(), contentText: event.text ?? null }
  }

  return {
    ...empty(),
    contentText: event.text ?? `[Unsupported message type: ${event.messageType ?? 'unknown'}]`,
  }
}