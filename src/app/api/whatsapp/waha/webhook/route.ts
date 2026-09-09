import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getWhatsAppProvider } from '@/lib/whatsapp/providers'
import { processNormalizedEvents } from '@/lib/whatsapp/webhook-processor'
import type { WhatsAppConfig } from '@/types'

// Same rationale as the Meta webhook route: inbound processing fans out
// to per-media downloads, so give `after()` headroom beyond the
// platform default.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing.
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

/**
 * Resolve the WAHA account that owns a webhook delivery. WAHA routes
 * events per session, so an exact `provider_config.sessionName` match
 * wins; failing that, a deploy with exactly one WAHA account owns
 * everything an un-sessioned payload could mean.
 */
async function resolveConfig(
  session: string | null,
): Promise<WhatsAppConfig | null> {
  const { data: configs, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('provider', 'waha' as const)

  if (error || !configs) {
    console.error('[waha-webhook] error fetching waha configs:', error)
    return null
  }
  if (configs.length === 0) {
    console.warn('[waha-webhook] no WAHA whatsapp_config rows — is the account configured?')
    return null
  }

  if (session) {
    const match = configs.find(
      (c: WhatsAppConfig) => (c.provider_config as { sessionName?: string } | null)?.sessionName === session,
    )
    if (match) return match
  }

  if (configs.length === 1) return configs[0]

  console.warn(
    `[waha-webhook] ${configs.length} WAHA configs and no session match for "${session}" — ` +
      'set provider_config.sessionName on each account and reconcile the WAHA sessions.',
  )
  return null
}

export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes WAHA
  // signed (same rule as the Meta webhook).
  const rawBody = await request.text()

  let body: { event?: string; session?: string; payload?: unknown }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const config = await resolveConfig(typeof body.session === 'string' ? body.session : null)
  if (!config) {
    return NextResponse.json({ error: 'Unknown session' }, { status: 404 })
  }

  const provider = getWhatsAppProvider(config, {
    storage: supabaseAdmin().storage,
  })

  // WAHA signs webhook payloads with the HMAC key set when the session
  // was configured (webhookSecret); fail closed when it's missing or
  // mismatched.
  const headers = Object.fromEntries(request.headers.entries())
  if (!provider.verifyWebhook?.(rawBody, headers)) {
    console.warn('[waha-webhook] rejected request with invalid HMAC')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Parse BEFORE `after()` so a malformed payload surfaces as a 400
  // rather than a silent 200.
  const events = provider.parseWebhook(body)
  if (events.length === 0) {
    // Heartbeats / irrelevant events still get a fast ack.
    return NextResponse.json({ status: 'received' }, { status: 200 })
  }

  // Same `after()` contract as the Meta route: guarantee the work runs
  // to completion on serverless platforms instead of freezing a
  // detached promise.
  after(async () => {
    try {
      await processNormalizedEvents(
        {
          supabase: supabaseAdmin(),
          provider,
          accountId: config.account_id,
          configOwnerUserId: config.user_id,
          mirrorMedia: config.mirror_inbound_media !== false,
        },
        events,
      )
    } catch (error) {
      console.error('[waha-webhook] error processing events:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}