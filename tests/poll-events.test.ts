import { describe, it, expect } from 'vitest';
import { pollEvents, newEventsState, type Deps } from '../src/main.js';
import { EventTracker } from '../src/events.js';
import { BrevoError, type BrevoClient, type BrevoDeliveryEvent } from '../src/brevo.js';
import type { Config } from '../src/config.js';
import type { LogSink } from '../src/logs.js';
import type { Telemetry } from '../src/telemetry.js';

const cfg = (over: Partial<Config['events']> = {}): Config => ({
  logs: true, intervalSeconds: 300, otlp: { endpoint: 'http://x' },
  events: { enabled: true, types: ['error', 'softBounces'], intervalSeconds: 900, includeSubject: true, includeRecipientDomain: true, ...over },
  accounts: [{ name: 'main', apiKey: 'k', dailyLimit: 300, timezone: 'Europe/Berlin', rules: [{ app: 'site', sender: 'noreply@example.com' }] }],
});
const ev = (id: string, event = 'error', o: Partial<BrevoDeliveryEvent> = {}): BrevoDeliveryEvent => ({
  date: '2026-11-02T10:43:00.000+01:00', event, from: 'noreply@example.com', subject: 'Website enquiry', messageId: id,
  email: 'jane.doe@private.example', reason: 'sender not valid', ...o,
});

function harness(events: Record<string, BrevoDeliveryEvent[]>, clock = { t: Date.parse('2026-11-02T12:00:00Z') }) {
  const emitted: { level: string; body: string; attrs: Record<string, unknown> }[] = [];
  const failures: Map<string, number>[] = [];
  const errors: string[] = [];
  const logsOut: Record<string, unknown>[] = [];
  const exp = { failures: 0, failNextFlush: false };
  const client = { getAccount: async () => ({ timezone: 'Europe/Berlin', remainingCredits: 1 }),
    listEvents: async (_d: string, t: string) => events[t] ?? [] } as unknown as BrevoClient;
  const tracker = new EventTracker();
  const deps: Deps = {
    clientFor: () => client, trackerFor: () => tracker,
    telemetry: { recordFailures: (_a: string, c: Map<string, number>) => failures.push(c), recordError: (a: string, r: string) => errors.push(`${a}:${r}`) } as unknown as Telemetry,
    logs: { emit: (level: string, body: string, attrs?: Record<string, unknown>) => emitted.push({ level, body, attrs: attrs ?? {} }),
      flush: async () => { if (exp.failNextFlush) { exp.failures++; exp.failNextFlush = false; } }, exportFailures: () => exp.failures, shutdown: async () => {} } as unknown as LogSink,
    now: () => new Date(clock.t), log: (e) => logsOut.push(e),
  };
  return { deps, emitted, failures, errors, logsOut, clock, exp, tracker };
}

describe('pollEvents', () => {
  it('baselines the first run, then emits only new failures, once', async () => {
    const h = harness({ error: [ev('a')] });
    const state = newEventsState();
    await pollEvents(cfg(), h.deps, state);
    expect(h.emitted).toHaveLength(0);                       // baseline
    h.clock.t += 901_000;
    await pollEvents(cfg(), h.deps, state);
    expect(h.emitted).toHaveLength(0);                       // nothing new
  });
  it('emits a new failure with severity, app and no recipient local part', async () => {
    const events: Record<string, BrevoDeliveryEvent[]> = { error: [ev('a')] };
    const h = harness(events);
    const state = newEventsState();
    await pollEvents(cfg(), h.deps, state);
    events.error = [ev('a'), ev('b')];
    h.clock.t += 901_000;
    await pollEvents(cfg(), h.deps, state);
    expect(h.emitted).toHaveLength(1);
    const r = h.emitted[0]!;
    expect(r.level).toBe('error');
    expect(r.attrs).toMatchObject({ 'brevo.event': 'error', 'brevo.message_id': 'b', app: 'site', 'recipient.domain': 'private.example', 'email.subject': 'Website enquiry' });
    expect(JSON.stringify(r)).not.toMatch(/jane/i);
  });
  it('honours includeSubject=false and includeRecipientDomain=false', async () => {
    const events: Record<string, BrevoDeliveryEvent[]> = {};
    const h = harness(events); const state = newEventsState();
    const c = cfg({ includeSubject: false, includeRecipientDomain: false });
    await pollEvents(c, h.deps, state);
    events.error = [ev('x')]; h.clock.t += 901_000;
    await pollEvents(c, h.deps, state);
    expect(Object.keys(h.emitted[0]!.attrs)).not.toContain('email.subject');
    expect(Object.keys(h.emitted[0]!.attrs)).not.toContain('recipient.domain');
  });
  it('attributes unmatched senders to "unattributed"', async () => {
    const events: Record<string, BrevoDeliveryEvent[]> = {};
    const h = harness(events); const state = newEventsState();
    await pollEvents(cfg(), h.deps, state);
    events.softBounces = [ev('s', 'softBounces', { from: 'other@example.com' })]; h.clock.t += 901_000;
    await pollEvents(cfg(), h.deps, state);
    expect(h.emitted[0]).toMatchObject({ level: 'warn', attrs: { app: 'unattributed' } });
  });
  it('reports today\'s counts per type, zeros included', async () => {
    const h = harness({ error: [ev('a'), ev('b')] });
    await pollEvents(cfg(), h.deps, newEventsState());
    expect(Object.fromEntries(h.failures[0]!)).toEqual({ error: 2, softBounces: 0 });
  });
  it('respects the events interval', async () => {
    const h = harness({}); const state = newEventsState();
    await pollEvents(cfg(), h.deps, state);
    await pollEvents(cfg(), h.deps, state);
    expect(h.failures).toHaveLength(1);
  });
  it('does nothing when disabled', async () => {
    const h = harness({ error: [ev('a')] });
    await pollEvents(cfg({ enabled: false }), h.deps, newEventsState());
    expect(h.failures).toHaveLength(0);
  });
  it('counts a Brevo failure as events_<reason> and keeps going', async () => {
    const h = harness({});
    (h.deps.clientFor('' as never) as unknown as { listEvents: unknown }).listEvents = async () => { throw new BrevoError('http_429', 'x'); };
    await pollEvents(cfg(), h.deps, newEventsState());
    expect(h.errors).toEqual(['main:events_http_429']);
  });
  it('also reads the previous day once when the local day rolls over', async () => {
    const asked: string[] = [];
    const h = harness({}, { t: Date.parse('2026-11-02T22:30:00Z') });
    (h.deps.clientFor('' as never) as unknown as { listEvents: unknown }).listEvents = async (d: string) => { asked.push(d); return []; };
    const state = newEventsState();
    await pollEvents(cfg(), h.deps, state);
    h.clock.t = Date.parse('2026-11-03T00:30:00Z');            // 01:30 next day in Berlin, also the 3rd in UTC
    await pollEvents(cfg(), h.deps, state);
    // poll 1: today only (2 types); poll 2: previous day, then the new day (2 types each)
    expect(asked).toEqual(['2026-11-02', '2026-11-02', '2026-11-02', '2026-11-02', '2026-11-03', '2026-11-03']);
  });
  it('never asks Brevo for a day that is still in the future in UTC (00:14 Berlin)', async () => {
    const asked: string[] = [];
    const h = harness({}, { t: Date.parse('2026-11-02T23:14:00Z') });
    (h.deps.clientFor('' as never) as unknown as { listEvents: unknown }).listEvents = async (d: string) => { asked.push(d); return []; };
    await pollEvents(cfg(), h.deps, newEventsState());
    expect(new Set(asked)).toEqual(new Set(['2026-11-02']));
  });
  it('does not lose events when the OTLP log export fails: rolls back and re-emits on the next poll', async () => {
    const events: Record<string, BrevoDeliveryEvent[]> = {};
    const h = harness(events); const state = newEventsState();
    await pollEvents(cfg(), h.deps, state);                    // baseline
    events.error = [ev('lost')]; h.clock.t += 901_000;
    h.exp.failNextFlush = true;
    await pollEvents(cfg(), h.deps, state);
    expect(h.errors).toEqual(['main:events_log_export']);
    expect(h.emitted).toHaveLength(1);
    h.clock.t += 901_000;
    await pollEvents(cfg(), h.deps, state);                    // exporter healthy again
    expect(h.emitted).toHaveLength(2);                          // same event emitted again (at-least-once)
    h.clock.t += 901_000;
    await pollEvents(cfg(), h.deps, state);
    expect(h.emitted).toHaveLength(2);                          // and now committed
  });
  it('reads the previous day after a restart (--once) using the persisted last day', async () => {
    const asked: string[] = [];
    const h = harness({}, { t: Date.parse('2026-11-02T20:00:00Z') });
    (h.deps.clientFor('' as never) as unknown as { listEvents: unknown }).listEvents = async (d: string) => { asked.push(d); return []; };
    await pollEvents(cfg(), h.deps, newEventsState());           // process 1
    asked.length = 0;
    h.clock.t = Date.parse('2026-11-03T08:00:00Z');
    await pollEvents(cfg(), h.deps, newEventsState());           // process 2: fresh in-memory state, same tracker/state file
    expect(new Set(asked)).toEqual(new Set(['2026-11-02', '2026-11-03']));
  });
  it('returns the number of accounts whose events poll failed (drives the --once exit code)', async () => {
    const h = harness({});
    expect(await pollEvents(cfg(), h.deps, newEventsState())).toBe(0);
    (h.deps.clientFor('' as never) as unknown as { listEvents: unknown }).listEvents = async () => { throw new BrevoError('http_5xx', 'x'); };
    expect(await pollEvents(cfg(), h.deps, newEventsState())).toBe(1);
  });
  it('counts the queried type in the failure counts', async () => {
    const h = harness({ error: [ev('a', 'Error')] });
    await pollEvents(cfg(), h.deps, newEventsState());
    expect(h.failures[0]!.get('error')).toBe(1);
  });
});
