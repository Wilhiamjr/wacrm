import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';

/**
 * Shared state the module mocks close over. Reset per test.
 */
const h = vi.hoisted(() => ({
  /** Session status the mocked WahaProvider reports. */
  sessionStatus: 'WORKING' as string,
  /** The whatsapp_config row the mocked client returns (null = none). */
  configRow: null as Record<string, unknown> | null,
  /** Authenticated user, or null to trigger the 401 path. */
  authUser: null as { id: string } | null,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () =>
        h.authUser
          ? { data: { user: h.authUser }, error: null }
          : { data: { user: null }, error: { message: 'no session' } },
    },
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                h.authUser
                  ? { data: { account_id: 'acc-1' }, error: null }
                  : { data: null, error: null },
            }),
          }),
        };
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: h.configRow, error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
  })),
}));

vi.mock('@/lib/whatsapp/providers', () => {
  class MockWahaProvider {
    constructor(public opts: { providerConfig: Record<string, unknown> }) {}
    async getSessionStatus() {
      return { status: h.sessionStatus };
    }
  }
  return {
    WahaProvider: MockWahaProvider,
    decryptProviderConfig: (pc: unknown) =>
      (pc as Record<string, unknown>) ?? {},
  };
});

function wahaRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'acc-1',
    provider: 'waha',
    provider_config: {
      baseUrl: 'http://waha.test',
      apiKey: 'secret-key',
      sessionName: 'crm-session',
    },
    ...overrides,
  };
}

describe('GET /api/whatsapp/waha/qr', () => {
  beforeEach(() => {
    h.authUser = { id: 'user-1' };
    h.configRow = wahaRow();
    h.sessionStatus = 'WORKING';
  });

  it('returns 401 when there is no authenticated session', async () => {
    h.authUser = null;
    const res = await GET(new Request('http://localhost/api/whatsapp/waha/qr'));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns 404 when the account has no WAHA config row', async () => {
    h.configRow = wahaRow({ provider: 'meta' });
    const res = await GET(new Request('http://localhost/api/whatsapp/waha/qr'));
    expect(res.status).toBe(404);
  });

  it('returns the live session status as JSON (no image requested)', async () => {
    h.sessionStatus = 'SCAN_QR_CODE';
    const res = await GET(new Request('http://localhost/api/whatsapp/waha/qr'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'SCAN_QR_CODE',
      connected: false,
    });
  });

  it('reports WORKING sessions as connected', async () => {
    const res = await GET(new Request('http://localhost/api/whatsapp/waha/qr'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'WORKING',
      connected: true,
    });
  });

  it('proxies the WAHA QR image with the API key for scans', async () => {
    h.sessionStatus = 'SCAN_QR_CODE';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      })
    );

    const res = await GET(
      new Request('http://localhost/api/whatsapp/waha/qr?format=image')
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://waha.test/api/crm-session/auth/qr?format=image',
      expect.objectContaining({
        headers: { 'X-Api-Key': 'secret-key' },
        cache: 'no-store',
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    );
    fetchMock.mockRestore();
  });

  it('falls back to the default session name for the QR URL', async () => {
    h.sessionStatus = 'SCAN_QR_CODE';
    h.configRow = wahaRow({
      provider_config: { baseUrl: 'http://waha.test', apiKey: 'secret-key' },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<svg/>', { status: 200 }));

    await GET(
      new Request('http://localhost/api/whatsapp/waha/qr?format=image')
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://waha.test/api/default/auth/qr?format=image',
      expect.anything()
    );
    fetchMock.mockRestore();
  });

  it("passes WAHA's answer through for a non-scan session", async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'Session not found or not in QR state' }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    const res = await GET(
      new Request('http://localhost/api/whatsapp/waha/qr?format=image')
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://waha.test/api/crm-session/auth/qr?format=image',
      expect.objectContaining({
        headers: { 'X-Api-Key': 'secret-key' },
        cache: 'no-store',
      })
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({
      error: 'Session not found or not in QR state',
    });
    fetchMock.mockRestore();
  });
});
