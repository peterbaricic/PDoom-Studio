// client.ts: a typed fetch wrapper for the studio's JSON API. Every mutation carries the per-start token from
// <meta name="studio-token">, set by studio/app.js when it serves index.html (or, in --dev mode, by the Vite plugin
// in vite.config.ts). If the studio server restarted since the page loaded, the token in the page is stale and every
// mutation gets a 403 "missing or wrong token" (studio/http.js's guard) — that's the one signal a long-open tab gets
// that it needs a reload, so it's turned into a sticky, subscribable flag here instead of just another failed request.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();
let restarted = false;

// The studio server restarted while this page was open: reload it. Read `restartedState.value`, or subscribe for
// when it flips (a plain external store, so any UI — HealthBanner, in a later task — can useSyncExternalStore it).
export const restartedState = {
  get value() {
    return restarted;
  },
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// Also called for a frame request's 403 (the player fetches frames itself) and a new server run on the event stream.
export function markRestarted() {
  if (restarted) return;
  restarted = true;
  for (const fn of listeners) fn();
}

// Test-only: lets client.test.ts start each test from a clean flag without reaching into module internals otherwise.
export function _resetRestartedForTests() {
  restarted = false;
}

function getToken(): string {
  return document.querySelector('meta[name="studio-token"]')?.getAttribute('content') ?? '';
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    /* not JSON, or no body: fall through to the status text */
  }
  return res.statusText || `HTTP ${res.status}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Sent on every request, GET included: studio/http.js's guard checks it on mutations and on the frame and coverage
  // GETs, and always attaching it keeps this simple and needs no per-method special case.
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-studio-token': getToken() };
  const hasBody = body !== undefined;
  const res = await fetch(path, { method, headers, body: hasBody ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const message = await readError(res);
    if (res.status === 403 && message.includes('token')) markRestarted();
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// The URL for one cached (or to-be-painted) frame — studio/app.js's GET /api/frames/<versionId>/<i>.jpg. Fetch it
// with frameHeaders(): the server answers frame requests only with the token (studio/http.js's guard).
export function frameHeaders(): Record<string, string> {
  return { 'x-studio-token': getToken() };
}
export function frameUrl(versionId: string, i: number, prio?: 'preview' | 'prefetch'): string {
  return `/api/frames/${encodeURIComponent(versionId)}/${i}.jpg${prio ? `?prio=${prio}` : ''}`;
}
