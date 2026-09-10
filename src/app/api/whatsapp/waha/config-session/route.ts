import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { WahaProvider } from '@/lib/whatsapp/providers';
import { encryptProviderConfig } from '@/lib/whatsapp/providers';
import type { WhatsAppConfig } from '@/types';

/**
 * Resolve the caller's account_id from their profile — same helper as
 * the Meta config route (see `@/app/api/whatsapp/config/route.ts`).
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data?.account_id) return null;
  return data.account_id as string;
}

/**
 * POST /api/whatsapp/waha/config-session
 *
 * Saves (or re-saves) the account's WAHA provider and wires the WAHA
 * session to this instance's webhook endpoint. Called from the
 * settings UI after the operator enters the WAHA base URL, api key and
 * session name.
 *
 * Body: `{ baseUrl, apiKey, sessionName }`.
 *
 * Response: 200 with `{ saved, session: {status}, qr_url }` — the QR url
 * is WAHA's own pairing endpoint; scanning it inside WAHA is what moves
 * the session from SCAN_QR_CODE to WORKING. Saving is not blocked on
 * the session being WORKING: an operator commonly saves before scanning.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { baseUrl, apiKey, sessionName } = body as {
      baseUrl?: unknown;
      apiKey?: unknown;
      sessionName?: unknown;
    };

    if (
      typeof baseUrl !== 'string' ||
      !baseUrl.trim() ||
      typeof apiKey !== 'string' ||
      !apiKey.trim() ||
      typeof sessionName !== 'string' ||
      !sessionName.trim()
    ) {
      return NextResponse.json(
        { error: 'baseUrl, apiKey and sessionName are required' },
        { status: 400 }
      );
    }

    // Probe the WAHA instance BEFORE persisting so the UI immediately
    // shows a bad URL / wrong api key instead of a silent save.
    const probe = new WahaProvider({
      providerConfig: {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        sessionName: sessionName.trim(),
      },
    });
    const credentials = await probe.verifyCredentials();
    if (!credentials.valid) {
      return NextResponse.json(
        {
          saved: false,
          error:
            credentials.error ??
            'Cannot reach the WAHA instance with these credentials.',
          session: await probe.getSessionStatus().catch(() => ({})),
        },
        { status: 400 }
      );
    }

    // Derive our webhook URL. WAHA must POST events to this instance, so
    // a canonical public base URL wins; fall back to the request's own
    // host when not configured (dev tunnels / Hostinger).
    const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()?.replace(
      /\/+$/,
      ''
    );
    const webhookUrl = explicit
      ? `${explicit}/api/whatsapp/waha/webhook`
      : request.headers.get('x-forwarded-host')
        ? `${
            request.headers.get('x-forwarded-proto') ?? 'https'
          }://${request.headers.get('x-forwarded-host')}/api/whatsapp/waha/webhook`
        : new URL(request.url).origin + '/api/whatsapp/waha/webhook';

    // A fresh random HMAC key for this session's webhook; the provider
    // signs each delivery with it and we verify on receipt.
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    const provider = new WahaProvider({
      providerConfig: {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        sessionName: sessionName.trim(),
        webhookSecret,
      },
    });

    const session = await provider.configureSession({
      webhookUrl,
      webhookSecret,
    });

    // Persist the provider switch for this account.
    const row: Partial<WhatsAppConfig> = {
      provider: 'waha',
      provider_config: encryptProviderConfig({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        sessionName: sessionName.trim(),
        webhookSecret,
      }),
      // Clearing the Meta columns keeps a stale phone_number_id from
      // confusing the Meta webhook's config lookup (migration 040 made
      // them nullable). `status`/`connected_at` are write-only and were
      // dropped in migration 041 — connected state is read live from
      // WAHA instead.
      phone_number_id: undefined,
      waba_id: undefined,
      access_token: undefined,
    };

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, account_id')
      .eq('account_id', accountId)
      .maybeSingle();

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(row)
        .eq('account_id', accountId);
      if (updateError) {
        console.error('[waha/config-session] update failed:', updateError);
        return NextResponse.json(
          { error: 'Failed to save WhatsApp configuration' },
          { status: 500 }
        );
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          ...row,
        });
      if (insertError) {
        console.error('[waha/config-session] insert failed:', insertError);
        return NextResponse.json(
          { error: 'Failed to save WhatsApp configuration' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      saved: true,
      status: session.status ?? 'STOPPED',
      connected: session.status === 'WORKING',
      qr_url:
        session.status === 'SCAN_QR_CODE' || session.status === 'STOPPED'
          ? `${baseUrl.trim().replace(/\/+$/, '')}/api/${encodeURIComponent(
              sessionName.trim()
            )}/auth/qr`
          : null,
      session,
    });
  } catch (error) {
    console.error('Error in WAHA config-session:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
