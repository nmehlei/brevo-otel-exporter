import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BrevoClient, BrevoError } from '../src/brevo.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const KEY = 'sk-super-secret-key';

function client(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    expect((init?.headers as Record<string, string>)['api-key']).toBe(KEY);
    return handler(String(input));
  }) as typeof fetch;
  return { c: new BrevoClient({ apiKey: KEY, fetch: fetchFn, timeoutMs: 500 }), urls };
}
const json = (s: string, status = 200) => new Response(s, { status });

describe('BrevoClient', () => {
  it('reads timezone and remaining credits', async () => {
    const { c } = client(() => json(fx('account.json')));
    expect(await c.getAccount()).toEqual({ timezone: 'Europe/Berlin', remainingCredits: 120 });
  });
  it('returns null credits without a sendLimit plan', async () => {
    const { c } = client(() => json('{"dateTimePreferences":{"timezone":"UTC"},"plan":[{"type":"paid","credits":5,"creditsType":"other"}]}'));
    expect((await c.getAccount()).remainingCredits).toBeNull();
  });
  it('gets the sent count, with tag only when given', async () => {
    const { c, urls } = client(() => json(fx('aggregated.json')));
    expect(await c.getSentCount('2026-11-02')).toBe(168);
    await c.getSentCount('2026-11-02', 'my app');
    expect(urls[0]).not.toContain('tag=');
    expect(urls[1]).toContain('tag=my%20app');
  });
  it('follows event pagination without duplicates', async () => {
    const { c, urls } = client((u) => json(fx(u.includes('offset=0') ? 'events-page1.json' : 'events-page2.json')));
    const ev = await c.listSendEvents('2026-11-02');
    expect(ev).toHaveLength(520);
    expect(new Set(ev.map((e) => e.messageId)).size).toBe(520);
    expect(urls).toHaveLength(2);
  });
  it('returns an empty list for an empty day', async () => {
    const { c } = client(() => json('{"events":[]}'));
    expect(await c.listSendEvents('2026-11-02')).toEqual([]);
  });
  it.each([[429, 'http_429'], [503, 'http_5xx'], [401, 'http_4xx']])('maps HTTP %i to %s', async (status, reason) => {
    const { c } = client(() => json('{}', status as number));
    await expect(c.getAccount()).rejects.toMatchObject({ reason });
  });
  it('maps a hang to timeout', async () => {
    const c = new BrevoClient({ apiKey: KEY, timeoutMs: 20, fetch: ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))) as typeof fetch });
    await expect(c.getAccount()).rejects.toMatchObject({ reason: 'timeout' });
  });
  it('maps bad JSON to parse and never leaks the key', async () => {
    const { c } = client(() => json('not json'));
    const err = await c.getAccount().catch((e) => e);
    expect(err).toBeInstanceOf(BrevoError);
    expect(err.reason).toBe('parse');
    expect(String(err.message)).not.toContain(KEY);
  });
});
