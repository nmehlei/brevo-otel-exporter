import { describe, it, expect } from 'vitest';
import { localDay, takeSnapshot } from '../src/snapshot.js';
import { BrevoError, type BrevoClient, type BrevoEvent } from '../src/brevo.js';
import type { AccountConfig } from '../src/config.js';

const ev = (subject: string): BrevoEvent => ({ date: 'd', from: 'a@b.c', subject, messageId: subject });
function fake(o: { credits?: number | null; total?: number; tags?: Record<string, number>; events?: BrevoEvent[] }) {
  const calls = { events: 0 };
  const c = {
    getAccount: async () => ({ timezone: 'Europe/Berlin', remainingCredits: o.credits === undefined ? 100 : o.credits }),
    getSentCount: async (_d: string, tag?: string) => (tag ? o.tags?.[tag] ?? 0 : o.total ?? 0),
    listSendEvents: async () => { calls.events++; return o.events ?? []; },
  } as unknown as BrevoClient;
  return { c, calls };
}
const cfg = (rules: AccountConfig['rules']): AccountConfig => ({ name: 'main', apiKey: 'k', dailyLimit: 300, rules });
const now = new Date('2026-11-02T10:00:00Z');

describe('localDay', () => {
  it('uses the account timezone day', () => {
    expect(localDay(new Date('2026-11-01T23:30:00Z'), 'Europe/Berlin')).toBe('2026-11-02');
    expect(localDay(new Date('2026-11-01T23:30:00Z'), 'UTC')).toBe('2026-11-01');
  });
});

describe('takeSnapshot', () => {
  it('combines tag and subject rules plus unattributed', async () => {
    const { c } = fake({ total: 10, tags: { landgang: 4 }, events: [ev('Weekly 1'), ev('Weekly 2'), ev('other')] });
    const s = await takeSnapshot(c, cfg([{ app: 'landgang', tag: 'landgang' }, { app: 'reports', subject: '^Weekly' }]), now);
    expect(s).toMatchObject({ account: 'main', dailyLimit: 300, sentToday: 10, remaining: 100 });
    expect(Object.fromEntries(s.byApp)).toEqual({ landgang: 4, reports: 2, unattributed: 4 });
  });
  it('does not list events without sender/subject rules', async () => {
    const { c, calls } = fake({ total: 5 });
    const s = await takeSnapshot(c, cfg([{ app: 'x', tag: 'x' }]), now);
    expect(calls.events).toBe(0);
    expect(s.byApp.get('unattributed')).toBe(5);
  });
  it('handles a day with zero sends', async () => {
    const { c } = fake({ total: 0 });
    const s = await takeSnapshot(c, cfg([{ app: 'r', subject: 'x' }]), now);
    expect(s.sentToday).toBe(0);
    expect(Object.fromEntries(s.byApp)).toEqual({ unattributed: 0 });
  });
  it('clamps negative credits and passes null through', async () => {
    expect((await takeSnapshot(fake({ credits: -3 }).c, cfg([]), now)).remaining).toBe(0);
    expect((await takeSnapshot(fake({ credits: null }).c, cfg([]), now)).remaining).toBeNull();
  });
  it('propagates client errors', async () => {
    const c = { getAccount: async () => { throw new BrevoError('http_429', 'x'); } } as unknown as BrevoClient;
    await expect(takeSnapshot(c, cfg([]), now)).rejects.toMatchObject({ reason: 'http_429' });
  });
});
