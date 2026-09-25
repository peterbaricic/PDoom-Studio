import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, api, restartedState, _resetRestartedForTests } from './client';

function setToken(token: string) {
  document.head.innerHTML = `<meta name="studio-token" content="${token}">`;
}

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const res = new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
  const fn = vi.fn().mockResolvedValue(res);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  setToken('tok-123');
  _resetRestartedForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('api client', () => {
  test('get sends the token header from the meta tag', async () => {
    const fetchMock = mockFetch(200, { ok: true });
    await api.get('/api/versions');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/versions');
    expect(init.method).toBe('GET');
    expect(init.headers['x-studio-token']).toBe('tok-123');
  });

  test('post sends the token header and a JSON body', async () => {
    const fetchMock = mockFetch(201, { id: 'a' });
    const result = await api.post('/api/versions', { id: 'a' });
    expect(result).toEqual({ id: 'a' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers['x-studio-token']).toBe('tok-123');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ id: 'a' }));
  });

  test('put and del also carry the token', async () => {
    let fetchMock = mockFetch(200, {});
    await api.put('/api/versions/a', { title: 'x' });
    expect(fetchMock.mock.calls[0]![1].headers['x-studio-token']).toBe('tok-123');

    fetchMock = mockFetch(200, { ok: true });
    await api.del('/api/library/1');
    expect(fetchMock.mock.calls[0]![1].method).toBe('DELETE');
    expect(fetchMock.mock.calls[0]![1].headers['x-studio-token']).toBe('tok-123');
  });

  test('a non-ok response throws ApiError with the status and the server message', async () => {
    mockFetch(404, { error: 'no such version' });
    let threw: unknown;
    try {
      await api.get('/api/versions/nope');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ApiError);
    expect((threw as ApiError).status).toBe(404);
    expect((threw as ApiError).message).toBe('no such version');
  });

  test('a non-JSON error body falls back to the status text', async () => {
    const res = new Response('not json', { status: 500, statusText: 'Internal Server Error' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    let threw: unknown;
    try {
      await api.get('/api/whatever');
    } catch (e) {
      threw = e;
    }
    expect((threw as ApiError).status).toBe(500);
    expect((threw as ApiError).message).toBe('Internal Server Error');
  });

  test('a 403 whose message contains "token" sets the restarted flag; other 403s do not', async () => {
    expect(restartedState.value).toBe(false);
    mockFetch(403, { error: 'wrong origin' });
    await api.post('/api/versions', {}).catch(() => {});
    expect(restartedState.value).toBe(false);

    mockFetch(403, { error: 'missing or wrong token' });
    await api.post('/api/versions', {}).catch(() => {});
    expect(restartedState.value).toBe(true);
  });

  test('the restarted flag is sticky and notifies subscribers exactly once', async () => {
    const seen: boolean[] = [];
    const unsubscribe = restartedState.subscribe(() => seen.push(restartedState.value));
    mockFetch(403, { error: 'missing or wrong token' });
    await api.post('/api/versions', {}).catch(() => {});
    mockFetch(403, { error: 'missing or wrong token' });
    await api.post('/api/versions', {}).catch(() => {});
    expect(seen).toEqual([true]);
    unsubscribe();
  });

  test('a 204 response resolves to undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect(await api.del('/api/library/1')).toBeUndefined();
  });
});
