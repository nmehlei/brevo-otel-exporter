import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFailures, EventTracker, toFailureEvent, severityFor, redact } from '../src/events.js';
import type { BrevoClient, BrevoDeliveryEvent } from '../src/brevo.js';

const raw = (o: Partial<BrevoDeliveryEvent> = {}): BrevoDeliveryEvent => ({
  date: '2026-11-02T10:43:00.000+01:00', event: 'error', from: 'noreply@example.com', subject: 'Hi',
  messageId: '<m1@x>', email: 'Jane.Doe@Example.ORG', reason: 'sender not valid', ...o,
});

describe('toFailureEvent', () => {
  it('keeps only the recipient domain, lowercased, never the address', () => {
    const f = toFailureEvent(raw());
    expect(f.recipientDomain).toBe('example.org');
    expect(JSON.stringify(f)).not.toMatch(/jane/i);
    expect(f.at.toISOString()).toBe('2026-11-02T09:43:00.000Z');
  });
  it('tolerates a missing address and reason', () => {
    const f = toFailureEvent(raw({ email: undefined, reason: undefined }));
    expect(f.recipientDomain).toBe('');
    expect(f.reason).toBe('');
  });
  it('truncates very long reasons', () => {
    expect(toFailureEvent(raw({ reason: 'x'.repeat(2000) })).reason.length).toBeLessThanOrEqual(500);
  });
});

describe('redaction', () => {
  it('removes email addresses from reason and subject but keeps the domain', () => {
    const f = toFailureEvent(raw({ reason: '550 5.1.1 <jane.doe@example.org>: Recipient address rejected', subject: 'Hello Jane (jane.doe@example.org)' }));
    expect(f.reason).toBe('550 5.1.1 <<redacted>@example.org>: Recipient address rejected');
    expect(f.subject).toBe('Hello Jane (<redacted>@example.org)');
    expect(JSON.stringify(f)).not.toMatch(/jane\.doe/i);
  });
  it('redact leaves text without addresses alone', () => expect(redact('sender not valid')).toBe('sender not valid'));
});

describe('invalid input', () => {
  it('skips events with an unparseable date instead of failing the poll', async () => {
    const client = { listEvents: async () => [raw({ date: 'garbage' }), raw({ messageId: '<ok@x>' })] } as unknown as BrevoClient;
    expect((await collectFailures(client, '2026-11-02', ['error'])).map((e) => e.messageId)).toEqual(['<ok@x>']);
  });
  it('uses the queried type, not the type spelled in the response', async () => {
    const client = { listEvents: async () => [raw({ event: 'Error' })] } as unknown as BrevoClient;
    expect((await collectFailures(client, '2026-11-02', ['error']))[0]!.event).toBe('error');
  });
});

describe('severityFor', () => {
  it('maps hard failures to error and transient ones to warn', () => {
    expect(severityFor('hardBounces')).toBe('error');
    expect(severityFor('blocked')).toBe('error');
    expect(severityFor('error')).toBe('error');
    expect(severityFor('softBounces')).toBe('warn');
    expect(severityFor('deferred')).toBe('warn');
  });
});

describe('collectFailures', () => {
  it('queries each configured type for the day and merges the results', async () => {
    const asked: string[] = [];
    const client = { listEvents: async (day: string, ev: string) => { asked.push(`${day}:${ev}`); return ev === 'error' ? [raw()] : []; } } as unknown as BrevoClient;
    const out = await collectFailures(client, '2026-11-02', ['error', 'blocked']);
    expect(asked).toEqual(['2026-11-02:error', '2026-11-02:blocked']);
    expect(out).toHaveLength(1);
  });
});

describe('EventTracker', () => {
  const fe = (id: string, event = 'error') => toFailureEvent(raw({ messageId: id, event }));
  const dir = () => mkdtempSync(join(tmpdir(), 'trk-'));

  it('baselines on the very first run: marks existing events seen, emits none', () => {
    const t = new EventTracker();
    expect(t.fresh([fe('a'), fe('b')], '2026-11-02')).toEqual([]);
    expect(t.fresh([fe('a'), fe('b'), fe('c')], '2026-11-02').map((e) => e.messageId)).toEqual(['c']);
  });
  it('emits each event only once', () => {
    const t = new EventTracker(); t.fresh([], '2026-11-02');
    expect(t.fresh([fe('a')], '2026-11-02')).toHaveLength(1);
    expect(t.fresh([fe('a')], '2026-11-02')).toHaveLength(0);
  });
  it('treats the same message with a different event type as a new event', () => {
    const t = new EventTracker(); t.fresh([], '2026-11-02');
    t.fresh([fe('a', 'softBounces')], '2026-11-02');
    expect(t.fresh([fe('a', 'hardBounces')], '2026-11-02')).toHaveLength(1);
  });
  it('persists across restarts and then does not re-baseline', () => {
    const p = join(dir(), 'state.json');
    const t1 = new EventTracker(p); t1.fresh([fe('a')], '2026-11-02'); t1.save();
    const t2 = new EventTracker(p);
    expect(t2.fresh([fe('a'), fe('b')], '2026-11-02').map((e) => e.messageId)).toEqual(['b']);
  });
  it('prunes entries of old days', () => {
    const p = join(dir(), 'state.json');
    const t = new EventTracker(p); t.fresh([fe('a')], '2026-11-01'); t.prune(['2026-11-02']); t.save();
    expect(JSON.parse(readFileSync(p, 'utf8')).seen).toEqual([]);
  });
  it('survives a corrupt state file by re-baselining', () => {
    const p = join(dir(), 'state.json'); writeFileSync(p, '{not json');
    const t = new EventTracker(p);
    expect(t.fresh([fe('a')], '2026-11-02')).toEqual([]);
  });
  it('save() without a path is a no-op', () => {
    const t = new EventTracker(); t.fresh([fe('a')], 'd');
    expect(() => t.save()).not.toThrow();
  });
  it('distinguishes two recipients of the same message', () => {
    const t = new EventTracker(); t.fresh([], 'd');
    const a = toFailureEvent(raw({ email: 'a@x.org' })); const b = toFailureEvent(raw({ email: 'b@x.org' }));
    expect(t.fresh([a, b], 'd')).toHaveLength(2);
  });
  it('rollback() un-sees staged events and restores the baseline state', () => {
    const t = new EventTracker(); t.fresh([], 'd'); t.commit();
    expect(t.fresh([fe('a')], 'd')).toHaveLength(1);
    t.rollback();
    expect(t.fresh([fe('a')], 'd')).toHaveLength(1);       // emitted again
    t.commit();
    expect(t.fresh([fe('a')], 'd')).toHaveLength(0);
    const fresh = new EventTracker(); fresh.fresh([fe('a')], 'd'); fresh.rollback();
    expect(fresh.fresh([fe('a')], 'd')).toEqual([]);        // still a baseline run
  });
  it('persists lastDay', () => {
    const p = join(dir(), 'state.json');
    const t1 = new EventTracker(p); t1.fresh([], 'd'); t1.lastDay = '2026-11-02'; t1.save();
    expect(new EventTracker(p).lastDay).toBe('2026-11-02');
  });
  it('moves a corrupt state file aside and reports it', () => {
    const p = join(dir(), 'state.json'); writeFileSync(p, '{not json');
    const t = new EventTracker(p);
    expect(t.loadWarning).toMatch(/corrupt/i);
    expect(existsSync(`${p}.corrupt`)).toBe(true);
    expect(existsSync(p)).toBe(false);
  });
  it('names the path and error code when the state cannot be written', () => {
    const t = new EventTracker(join(dir(), 'missing-dir', 'state.json')); t.fresh([fe('a')], 'd');
    expect(() => t.save()).toThrow(/missing-dir.*ENOENT/);
  });
});
