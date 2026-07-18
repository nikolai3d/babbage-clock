import { describe, expect, it } from 'vitest';
import {
  cloudflareTraceProvider,
  defaultProviders,
  httpDateProvider,
  timeApiIoProvider,
} from './providers.js';
import type { FetchLike } from './providers.js';

/**
 * Every provider is exercised against a stub. Nothing in this file may reach
 * the network: a unit test that depends on timeapi.io being up is a unit test
 * that fails at 3am for reasons unrelated to the code.
 */
interface StubResponse {
  readonly ok?: boolean;
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

type StubFetch = FetchLike & { readonly urls: string[] };

function stubFetch(response: StubResponse): StubFetch {
  const urls: string[] = [];
  const headers = response.headers ?? {};

  const impl: FetchLike = (url) => {
    urls.push(url);
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: () => Promise.resolve(response.body ?? ''),
    });
  };

  return Object.assign(impl, { urls });
}

const signal = new AbortController().signal;

describe('timeApiIoProvider', () => {
  it('reads the UTC dateTime field as UTC, not as local time', async () => {
    const fetchImpl = stubFetch({ body: JSON.stringify({ dateTime: '2026-07-18T06:05:51.137' }) });
    const provider = timeApiIoProvider(fetchImpl);

    await expect(provider.fetchServerTime(signal)).resolves.toBe(
      Date.UTC(2026, 6, 18, 6, 5, 51, 137),
    );
    expect(fetchImpl.urls[0]).toContain('timeZone=UTC');
    expect(provider.tier).toBe('ntp-lite');
    expect(provider.resolutionMs).toBe(1);
  });

  it('tolerates a trailing Z on the field', async () => {
    const provider = timeApiIoProvider(
      stubFetch({ body: JSON.stringify({ dateTime: '2026-07-18T06:05:51.137Z' }) }),
    );

    await expect(provider.fetchServerTime(signal)).resolves.toBe(
      Date.UTC(2026, 6, 18, 6, 5, 51, 137),
    );
  });

  it('rejects on a bad status, malformed JSON or a missing field', async () => {
    await expect(
      timeApiIoProvider(stubFetch({ ok: false, status: 503 })).fetchServerTime(signal),
    ).rejects.toThrow('503');
    await expect(
      timeApiIoProvider(stubFetch({ body: 'not json' })).fetchServerTime(signal),
    ).rejects.toThrow();
    await expect(
      timeApiIoProvider(stubFetch({ body: '{}' })).fetchServerTime(signal),
    ).rejects.toThrow('no dateTime');
    await expect(
      timeApiIoProvider(stubFetch({ body: JSON.stringify({ dateTime: 'nope' }) })).fetchServerTime(
        signal,
      ),
    ).rejects.toThrow('unparseable');
  });
});

describe('cloudflareTraceProvider', () => {
  it('parses fractional epoch seconds out of the trace body', async () => {
    const provider = cloudflareTraceProvider(
      stubFetch({ body: 'fl=123abc\nh=cloudflare.com\nts=1784355182.461\nvisit_scheme=https\n' }),
    );

    await expect(provider.fetchServerTime(signal)).resolves.toBe(1_784_355_182_461);
  });

  it('rejects when the ts line is absent or unusable', async () => {
    await expect(
      cloudflareTraceProvider(stubFetch({ body: 'fl=123abc\n' })).fetchServerTime(signal),
    ).rejects.toThrow('no ts field');
  });
});

describe('httpDateProvider', () => {
  it('centres the one-second Date header rather than biasing it early', async () => {
    const provider = httpDateProvider(
      'https://example.test/app',
      stubFetch({ headers: { date: 'Sat, 18 Jul 2026 06:06:01 GMT' } }),
    );

    // The true instant lies in [06:06:01, 06:06:02), so the midpoint is +500 ms.
    await expect(provider.fetchServerTime(signal)).resolves.toBe(
      Date.UTC(2026, 6, 18, 6, 6, 1) + 500,
    );
    expect(provider.tier).toBe('http-date');
    expect(provider.resolutionMs).toBe(1_000);
  });

  it('cache-busts so a replayed response cannot supply a stale Date', async () => {
    const fetchImpl = stubFetch({ headers: { date: 'Sat, 18 Jul 2026 06:06:01 GMT' } });
    await httpDateProvider('https://example.test/app?x=1', fetchImpl).fetchServerTime(signal);

    expect(fetchImpl.urls[0]).toMatch(/\?x=1&_t=\d+$/);
  });

  it('rejects when the header is missing or unparseable', async () => {
    await expect(
      httpDateProvider('https://example.test/', stubFetch({})).fetchServerTime(signal),
    ).rejects.toThrow('no Date header');
    await expect(
      httpDateProvider(
        'https://example.test/',
        stubFetch({ headers: { date: 'sometime on Tuesday' } }),
      ).fetchServerTime(signal),
    ).rejects.toThrow('unparseable');
  });
});

describe('defaultProviders', () => {
  it('is ordered best-first and ends on the coarse but robust source', () => {
    const providers = defaultProviders(stubFetch({}));

    expect(providers.map((provider) => provider.id)).toEqual([
      'timeapi.io',
      'cloudflare-trace',
      'http-date',
    ]);
    expect(providers.map((provider) => provider.tier)).toEqual([
      'ntp-lite',
      'ntp-lite',
      'http-date',
    ]);
  });

  it('can be constructed without a fetch implementation present', () => {
    // Building the chain must not throw even where fetch is unavailable; the
    // failure belongs at sync time, where it degrades to the device clock.
    expect(() => defaultProviders()).not.toThrow();
  });
});
