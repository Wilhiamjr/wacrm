import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  WahaProvider,
  decryptProviderConfig,
  type ProviderConfig,
} from '@/lib/whatsapp/providers';

/**
 * Resolve the caller's account_id from their profile — same helper as
 * the WAHA config-session route.
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
 * GET /api/whatsapp/waha/qr
 *
 * Session status + pairing QR for the account's WAHA session, served
 * WITHOUT exposing the WAHA api key to the browser:
 *
 * - `GET /api/whatsapp/waha/qr` → JSON `{ status, connected }`. The
 *   settings page polls this while the number is being paired.
 * - `GET /api/whatsapp/waha/qr?format=image` → proxies WAHA's QR endpoint
 *   (`/api/{session}/auth/qr?format=image`, which requires X-Api-Key) so
 *   it can be rendered inline in an <img> tag. WAHA's answer is passed
 *   through unchanged: a QR image while the session waits for a scan, and
 *   an error status for states with no QR (e.g. WORKING). Callers refresh
 *   the image when the polled status becomes SCAN_QR_CODE, which avoids a
 *   broken <img> during the STARTING → SCAN_QR_CODE transition.
 */
export async function GET(request: Request) {
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

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    if (configError) {
      console.error('[waha/qr] load failed:', configError);
      return NextResponse.json(
        { error: 'Failed to load WhatsApp configuration' },
        { status: 500 }
      );
    }

    if (config?.provider !== 'waha') {
      return NextResponse.json(
        { error: 'No WAHA configuration for this account.' },
        { status: 404 }
      );
    }

    let pc: ProviderConfig;
    let provider: WahaProvider;
    try {
      pc = decryptProviderConfig(
        (config.provider_config ?? {}) as ProviderConfig
      );
      provider = new WahaProvider({ providerConfig: pc });
    } catch (error) {
      console.error('[waha/qr] provider init failed:', error);
      return NextResponse.json(
        { error: 'Stored WAHA configuration is invalid.' },
        { status: 500 }
      );
    }

    const session = await provider.getSessionStatus().catch(() => null);
    const status = session?.status ?? 'UNKNOWN';
    const connected = status === 'WORKING';

    const wantsImage =
      new URL(request.url).searchParams.get('format') === 'image';
    if (!wantsImage) {
      return NextResponse.json({ status, connected });
    }

    // Proxy WAHA's QR endpoint verbatim rather than gating on the session
    // state — the polled status and this image are read on different
    // cadences, so a strict SCAN_QR_CODE-only gate above renders a broken
    // <img> during STARTING/STOPPED. The UI bumps its cache-busting query
    // param when the poll observes SCAN_QR_CODE, so the panel self-heals.
    const baseUrl =
      typeof pc.baseUrl === 'string' ? pc.baseUrl.replace(/\/+$/, '') : '';
    const apiKey = typeof pc.apiKey === 'string' ? pc.apiKey : '';
    const sessionName =
      typeof pc.sessionName === 'string' && pc.sessionName
        ? pc.sessionName
        : 'default';

    const qrRes = await fetch(
      `${baseUrl}/api/${encodeURIComponent(sessionName)}/auth/qr?format=image`,
      { headers: { 'X-Api-Key': apiKey }, cache: 'no-store' }
    );
    const contentType = qrRes.headers.get('content-type') || 'image/svg+xml';
    if (!qrRes.ok) {
      // No QR for this state (WORKING, or the engine still booting). Pass
      // WAHA's answer through so the status/error is authoritative.
      return new NextResponse(qrRes.body, {
        status: qrRes.status,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
      });
    }

    const body = new Uint8Array(await qrRes.arrayBuffer());
    return new NextResponse(body, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Error in WAHA qr:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
