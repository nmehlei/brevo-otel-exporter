import { describe, it, expect } from 'vitest';
import { pollOnce } from '../src/main.js';
import { BrevoError, type BrevoClient } from '../src/brevo.js';
import type { Config } from '../src/config.js';
import type { Telemetry } from '../src/telemetry.js';

const SECRET = 'sk-very-secret';
const cfg: Config = {
  intervalSeconds: 300, otlp: { endpoint: 'http://x' },
  accounts: [
    { name: 'good', apiKey: SECRET, dailyLimit: 300, rules: [] },
    { name: 'bad', apiKey: SECRET, dailyLimit: 300, rules: [] },
  ],
};
const good = { getAccount: async () => ({ timezone: 'UTC', remainingCredits: 10 }), getSentCount: async () => 5, listSendEvents: async () => [] } as unknown as BrevoClient;
const bad = { getAccount: async () => { throw new BrevoError('http_429', 'rate limited'); } } as unknown as BrevoClient;

describe('pollOnce', () => {
  it('keeps going when one account fails and never logs the key', async () => {
    const ok: string[] = []; const errs: string[] = []; const logs: string[] = [];
    const telemetry = { recordSuccess: (s) => ok.push(s.account), recordError: (a, r) => errs.push(`${a}:${r}`), exportFailures: () => 0, flush: async () => {}, shutdown: async () => {} } as Telemetry;
    const r = await pollOnce(cfg, {
      clientFor: (a) => (a.name === 'good' ? good : bad), telemetry, now: () => new Date('2026-11-02T10:00:00Z'),
      log: (e) => logs.push(JSON.stringify(e)),
    });
    expect(r).toEqual({ ok: 1, failed: 1 });
    expect(ok).toEqual(['good']);
    expect(errs).toEqual(['bad:http_429']);
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(logs.join('\n')).toContain('http_429');
  });
  it('counts a non-Brevo exception as reason "unexpected"', async () => {
    const errs: string[] = [];
    const boom = { getAccount: async () => { throw new TypeError('x'); } } as unknown as BrevoClient;
    const telemetry = { recordSuccess() {}, recordError: (a, r) => errs.push(`${a}:${r}`), exportFailures: () => 0, flush: async () => {}, shutdown: async () => {} } as Telemetry;
    await pollOnce(cfg, { clientFor: () => boom, telemetry, now: () => new Date(), log: () => {} });
    expect(errs).toEqual(['good:unexpected', 'bad:unexpected']);
  });
});
