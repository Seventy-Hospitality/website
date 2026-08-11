import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, request } from './api';

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(handler: (...args: FetchArgs) => Response | Promise<Response>) {
  const spy = vi.fn(handler);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('unwraps the data envelope', async () => {
    mockFetch(() => jsonResponse({ data: { userId: 'u1', email: 'a@b.c' } }));

    const me = await api.getMe();
    expect(me).toEqual({ userId: 'u1', email: 'a@b.c' });
  });

  it('throws ApiError with code, status, and message from the error envelope', async () => {
    mockFetch(() =>
      jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'Bad email' } }, 400),
    );

    const error = await api.signIn({ email: 'x', password: 'y' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VALIDATION_ERROR');
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe('Bad email');
  });

  it('falls back to UNKNOWN for non-JSON error bodies', async () => {
    mockFetch(() => new Response('gateway exploded', { status: 502 }));

    const error = await api.getMe().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UNKNOWN');
    expect((error as ApiError).status).toBe(502);
  });

  it('sends credentials and the X-Client-Type: web header on auth calls', async () => {
    const spy = mockFetch(() => jsonResponse({ data: { user: {} } }));

    await api.signIn({ email: 'a@b.c', password: 'secret123' });

    const [url, init] = spy.mock.calls[0] as FetchArgs;
    expect(String(url)).toBe('/api/auth/signin');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('X-Client-Type')).toBe('web');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('does not send X-Client-Type outside /api/auth/', async () => {
    const spy = mockFetch(() => jsonResponse({ data: [] }));

    await request('/api/me/bookings');

    const [, init] = spy.mock.calls[0] as FetchArgs;
    expect(new Headers(init?.headers).get('X-Client-Type')).toBeNull();
  });

  it('refreshes once and retries when a non-auth request returns 401', async () => {
    let bookingCalls = 0;
    const urls: string[] = [];
    mockFetch((input) => {
      const url = String(input);
      urls.push(url);
      if (url === '/api/me/bookings') {
        bookingCalls += 1;
        if (bookingCalls === 1) {
          return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401);
        }
        return jsonResponse({ data: [{ id: 'b1' }] });
      }
      if (url === '/api/auth/refresh') {
        return jsonResponse({ data: { user: {} } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await request('/api/me/bookings');

    expect(result).toEqual([{ id: 'b1' }]);
    expect(urls).toEqual(['/api/me/bookings', '/api/auth/refresh', '/api/me/bookings']);
  });

  it('surfaces the original 401 when the refresh fails', async () => {
    mockFetch((input) => {
      const url = String(input);
      if (url === '/api/auth/refresh') {
        return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'no cookie' } }, 401);
      }
      return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401);
    });

    const error = await request('/api/me/bookings').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it('never tries to refresh auth endpoints themselves', async () => {
    const spy = mockFetch(() =>
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'nope' } }, 401),
    );

    await api.signIn({ email: 'a@b.c', password: 'wrong' }).catch(() => undefined);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
