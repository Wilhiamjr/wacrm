import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'
import { getWhatsAppProvider } from '@/lib/whatsapp/providers'
import { processNormalizedEvents } from '@/lib/whatsapp/webhook-processor'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /**
   * Set when the customer taps a QUICK_REPLY button on a *template*
   * message — a broadcast, or any template send. Meta uses a different
   * envelope from `interactive` above: `type: 'button'`, the label in
   * `button.text`, and the payload configured on the template's button
   * in `button.payload` (Meta's own template editor doesn't ask for a
   * payload and mirrors the label into it).
   */
  button?: { text?: string; payload?: string }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product?: string
      metadata?: {
        display_phone_number?: string
        phone_number_id?: string
      }
      contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{ id: string; status: string; timestamp: string; recipient_id: string }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion. See the `after()` comment
  // below for why this must be `after()` and not a detached promise.
  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin(),
        )
        continue
      }

      const value = change.value

      // Statuses-only deliveries still need a config lookup below, but
      // there is nothing message-shaped in them — skip straight on.
      const hasMessages = Array.isArray(value.messages) && value.messages.length > 0
      if (!hasMessages) {
        if (Array.isArray(value.statuses) && value.statuses.length > 0) {
          // Status events resolve the account the same way messages do —
          // but the processor handles them without touching metadata.
          // Look the config up by phone_number_id when present so the
          // events still land on the right provider context.
          if (value.metadata?.phone_number_id) {
            await processChangeEvents(entry, change)
          }
        }
        continue
      }

      await processChangeEvents(entry, change)
    }
  }
}

/**
 * Resolve the config that owns one Meta change, build the provider for
 * it, parse the change's events into the normalized shape, and feed the
 * shared processor.
 */
async function processChangeEvents(
  entry: WhatsAppWebhookEntry,
  change: WhatsAppWebhookEntry['changes'][number],
) {
  const phoneNumberId = change.value.metadata?.phone_number_id
  if (!phoneNumberId) {
    // Status deliveries may lack the metadata block entirely; the
    // processor needs the account context for status fan-out, so we
    // can't build it here. Log and move on.
    console.warn('[webhook] change without metadata.phone_number_id:', change.field)
    return
  }

  const { data: configRows, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('phone_number_id', phoneNumberId)

  if (configError) {
    console.error(
      'Error fetching whatsapp_config for phone_number_id:',
      phoneNumberId,
      configError,
    )
    return
  }

  if (!configRows || configRows.length === 0) {
    console.error('No config found for phone_number_id:', phoneNumberId)
    return
  }

  if (configRows.length > 1) {
    console.error(
      `Multiple configs (${configRows.length}) found for phone_number_id:`,
      phoneNumberId,
      '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
      'Account owners:',
      configRows.map((r: { account_id: string; user_id: string }) => `${r.account_id} (admin ${r.user_id})`),
    )
    return
  }

  const config = configRows[0]

  const provider = getWhatsAppProvider(config, {
    accessToken: decrypt(config.access_token),
    storage: supabaseAdmin().storage,
  })

  const events = provider.parseWebhook({
    entry: [
      {
        id: entry.id,
        changes: [{ field: change.field, value: change.value as unknown }],
      },
    ],
  })

  if (events.length > 0) {
    await processNormalizedEvents(
      {
        supabase: supabaseAdmin(),
        provider,
        accountId: config.account_id,
        configOwnerUserId: config.user_id,
        // Default ON: the column is NOT NULL DEFAULT TRUE, but a row
        // read before migration 039 lands would have it undefined.
        mirrorMedia: config.mirror_inbound_media !== false,
      },
      events,
    )
  }
}