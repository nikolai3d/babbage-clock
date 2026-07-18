/**
 * Where an authoritative UTC instant comes from.
 *
 * Each provider answers one question — "what time do you have?" — and nothing
 * else. Round-trip timing, outlier rejection and offset estimation all live in
 * `trueTime.ts`, so a provider is trivial to fake in tests: it is a function
 * returning a number.
 *
 * The chain degrades on purpose. A JSON API gives millisecond resolution; the
 * `Date` response header gives one-second resolution but is served by literally
 * every HTTP origin, including the one the app was loaded from, which makes it
 * the last network step before giving up and trusting the device.
 */

/** How good the resulting time is, coarsest last. */
export type AccuracyTier = 'ntp-lite' | 'http-date' | 'device-clock';

export interface TimeProvider {
  /** Stable id, surfaced in the status readout. */
  readonly id: string;
  readonly tier: AccuracyTier;
  /**
   * Quantisation of the returned value in milliseconds — 1 for a JSON API with
   * a millisecond field, 1000 for a `Date` header.
   */
  readonly resolutionMs: number;
  /** Resolves the server's UTC epoch ms. Rejects on any failure. */
  readonly fetchServerTime: (signal: AbortSignal) => Promise<number>;
}

/** Injected so tests never touch the network. */
export type FetchLike = (
  input: string,
  init: { method: string; signal: AbortSignal; cache: 'no-store' },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}>;

/**
 * Resolved at call time, not at module load: constructing the default provider
 * chain must not throw in an environment without `fetch` (it should simply
 * fail over to the device clock when a sync is actually attempted).
 */
const lazyFetch: FetchLike = (input, init) => {
  if (typeof fetch !== 'function') {
    throw new Error('fetch is unavailable in this environment');
  }
  return (fetch as unknown as FetchLike)(input, init);
};

async function readBody(
  url: string,
  method: 'GET' | 'HEAD',
  signal: AbortSignal,
  fetchImpl: FetchLike,
): Promise<{ text: string; headers: { get: (name: string) => string | null } }> {
  const response = await fetchImpl(url, { method, signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} responded ${String(response.status)}`);
  return { text: method === 'HEAD' ? '' : await response.text(), headers: response.headers };
}

/**
 * Primary: timeapi.io.
 *
 * Chosen over worldtimeapi.org because it sends `Access-Control-Allow-Origin:
 * *` (verified), returns sub-second precision, and was reachable when
 * worldtimeapi.org was failing its TLS handshake outright. It is still a free
 * third-party service with no uptime guarantee — hence the rest of the chain.
 *
 * `dateTime` comes back as a zone-less wall clock for the requested zone; we
 * ask for UTC and append `Z` rather than letting the platform guess.
 */
export function timeApiIoProvider(fetchImpl: FetchLike = lazyFetch): TimeProvider {
  return {
    id: 'timeapi.io',
    tier: 'ntp-lite',
    resolutionMs: 1,
    fetchServerTime: async (signal) => {
      const { text } = await readBody(
        'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
        'GET',
        signal,
        fetchImpl,
      );
      const body = JSON.parse(text) as { dateTime?: unknown };
      if (typeof body.dateTime !== 'string') throw new Error('timeapi.io: no dateTime field');
      // The field is UTC wall clock without a designator; make that explicit.
      const parsed = Date.parse(`${body.dateTime.replace(/Z$/i, '')}Z`);
      if (Number.isNaN(parsed))
        throw new Error(`timeapi.io: unparseable dateTime ${body.dateTime}`);
      return parsed;
    },
  };
}

/**
 * Secondary: Cloudflare's `cdn-cgi/trace` edge diagnostic.
 *
 * Deliberately a different operator and a different failure mode from the
 * primary: it is served from whichever Cloudflare edge is nearest, it sends
 * `access-control-allow-origin: *` (verified), and its `ts=` line carries
 * fractional epoch seconds. It is not a documented time API and could change
 * shape, which is why a parse failure just falls through to the next provider.
 */
export function cloudflareTraceProvider(fetchImpl: FetchLike = lazyFetch): TimeProvider {
  return {
    id: 'cloudflare-trace',
    tier: 'ntp-lite',
    resolutionMs: 1,
    fetchServerTime: async (signal) => {
      const { text } = await readBody(
        'https://cloudflare.com/cdn-cgi/trace',
        'GET',
        signal,
        fetchImpl,
      );
      const match = /^ts=([0-9.]+)$/m.exec(text);
      if (!match?.[1]) throw new Error('cloudflare-trace: no ts field');
      const seconds = Number(match[1]);
      if (!Number.isFinite(seconds)) throw new Error('cloudflare-trace: unparseable ts');
      return Math.round(seconds * 1000);
    },
  };
}

/**
 * Tertiary: the `Date` response header of a HEAD request.
 *
 * `Date` is a CORS-safelisted response header, so this works against any HTTPS
 * origin — but pointing it at the app's own origin means no third party has to
 * be up at all. Resolution is one second: the header is truncated, so the true
 * instant lies uniformly in `[value, value + 1s)` and we add 500 ms to centre
 * the estimate rather than biasing it a full second early.
 */
export function httpDateProvider(url?: string, fetchImpl: FetchLike = lazyFetch): TimeProvider {
  const target = url ?? defaultSameOriginUrl();
  return {
    id: 'http-date',
    tier: 'http-date',
    resolutionMs: 1000,
    fetchServerTime: async (signal) => {
      // Cache-bust: a 304 or a memory-cache hit would replay a stale `Date`.
      const separator = target.includes('?') ? '&' : '?';
      const { headers } = await readBody(
        `${target}${separator}_t=${String(Date.now())}`,
        'HEAD',
        signal,
        fetchImpl,
      );
      const header = headers.get('date');
      if (!header) throw new Error('http-date: no Date header');
      const parsed = Date.parse(header);
      if (Number.isNaN(parsed)) throw new Error(`http-date: unparseable Date header ${header}`);
      return parsed + 500;
    },
  };
}

function defaultSameOriginUrl(): string {
  if (typeof location !== 'undefined' && typeof location.origin === 'string') {
    return `${location.origin}${location.pathname}`;
  }
  return 'https://timeapi.io/';
}

/** The shipping chain, best first. */
export function defaultProviders(fetchImpl?: FetchLike): readonly TimeProvider[] {
  const impl = fetchImpl ?? lazyFetch;
  return [
    timeApiIoProvider(impl),
    cloudflareTraceProvider(impl),
    httpDateProvider(undefined, impl),
  ];
}
