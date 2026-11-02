#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { BrevoClient, BrevoError } from './brevo.js';
import { loadConfig, type AccountConfig, type Config } from './config.js';
import { takeSnapshot, queryDay } from './snapshot.js';
import { classifyEvent } from './attribution.js';
import { collectFailures, EventTracker, severityFor } from './events.js';
import { createLogSink, nullSink, type LogSink } from './logs.js';
import { createTelemetry, type Telemetry } from './telemetry.js';

export interface Deps {
  clientFor(a: AccountConfig): BrevoClient;
  telemetry: Telemetry;
  now(): Date;
  log(e: Record<string, unknown>): void;
  /** Sink for delivery-failure log records (not the exporter's own log lines). */
  logs?: LogSink;
  trackerFor?(a: AccountConfig): EventTracker;
}

export interface EventsState { lastRun: Map<string, number>; lastDay: Map<string, string> }
export const newEventsState = (): EventsState => ({ lastRun: new Map(), lastDay: new Map() });

/** Exports Brevo delivery failures as log records (once each) and today's failure counts as a metric. */
export async function pollEvents(cfg: Config, deps: Deps, state: EventsState): Promise<void> {
  if (!cfg.events.enabled || !deps.logs || !deps.trackerFor) return;
  const nowMs = deps.now().getTime();
  for (const a of cfg.accounts) {
    if (nowMs - (state.lastRun.get(a.name) ?? 0) < cfg.events.intervalSeconds * 1000) continue;
    try {
      const client = deps.clientFor(a);
      const tz = a.timezone ?? (await client.getAccount()).timezone;
      const today = queryDay(deps.now(), tz);
      const prev = state.lastDay.get(a.name);
      const days = prev && prev !== today ? [prev, today] : [today];
      const tracker = deps.trackerFor(a);
      const counts = new Map<string, number>(cfg.events.types.map((t) => [t, 0]));
      let emitted = 0;
      for (const day of days) {
        const events = await collectFailures(client, day, cfg.events.types);
        for (const e of tracker.fresh(events, day)) {
          const app = classifyEvent({ date: '', from: e.sender, subject: e.subject, messageId: e.messageId }, a.rules) ?? 'unattributed';
          deps.logs.emit(severityFor(e.event), `Brevo delivery problem: ${e.event}`, {
            'brevo.account': a.name, 'brevo.event': e.event, 'brevo.message_id': e.messageId,
            'brevo.sender': e.sender, 'brevo.reason': e.reason, app,
            ...(cfg.events.includeRecipientDomain && e.recipientDomain ? { 'recipient.domain': e.recipientDomain } : {}),
            ...(cfg.events.includeSubject ? { 'email.subject': e.subject } : {}),
          }, e.at);
          emitted++;
        }
        if (day === today) for (const e of events) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
      }
      tracker.prune([today]);
      tracker.save();
      deps.telemetry.recordFailures(a.name, counts, deps.now());
      state.lastRun.set(a.name, nowMs);
      state.lastDay.set(a.name, today);
      deps.log({ level: 'info', msg: 'events polled', account: a.name, newFailures: emitted });
    } catch (e) {
      const reason = e instanceof BrevoError ? e.reason : 'unexpected';
      deps.telemetry.recordError(a.name, `events_${reason}`);
      deps.log({ level: 'error', msg: 'events poll failed', account: a.name, reason, error: e instanceof BrevoError ? e.message : (e as Error).name });
    }
  }
}

export async function pollOnce(cfg: Config, deps: Deps): Promise<{ ok: number; failed: number }> {
  let ok = 0; let failed = 0;
  for (const a of cfg.accounts) {
    try {
      const snap = await takeSnapshot(deps.clientFor(a), a, deps.now());
      deps.telemetry.recordSuccess(snap, deps.now());
      if (snap.overAttributed > 0) deps.log({ level: 'warn', msg: 'overlapping attribution rules: mails counted more than once', account: a.name, overAttributed: snap.overAttributed });
      deps.log({ level: 'info', msg: 'poll ok', account: a.name, sentToday: snap.sentToday, remaining: snap.remaining });
      ok++;
    } catch (e) {
      const reason = e instanceof BrevoError ? e.reason : 'unexpected';
      deps.telemetry.recordError(a.name, reason);
      deps.log({ level: 'error', msg: 'poll failed', account: a.name, reason, error: e instanceof BrevoError ? e.message : (e as Error).name });
      failed++;
    }
  }
  return { ok, failed };
}

const USAGE = `Usage: brevo-otel-exporter --config <path> [--once]

  --config  path to the YAML config (see examples/config.yaml)
  --once    poll once, flush metrics and exit (exit 1 if every account failed)
`;

async function cli(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help || !values.config) { process.stdout.write(USAGE); process.exit(values.help ? 0 : 2); }

  let cfg: Config;
  try { cfg = loadConfig(values.config!, process.env); }
  catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exit(2); }

  const logs: LogSink = cfg.logs || cfg.events.enabled ? createLogSink(cfg.otlp) : nullSink;
  const stdout = (e: Record<string, unknown>) => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...e }) + '\n');
  const log = (e: Record<string, unknown>) => {
    stdout(e);
    if (!cfg.logs) return;
    const { level, msg, ...rest } = e;
    const attrs: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null) attrs[k] = typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean);
    logs.emit(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', String(msg), attrs);
  };
  const telemetry = createTelemetry(cfg.otlp, undefined, {
    staleAfterMs: cfg.intervalSeconds * 3 * 1000,
    onExportError: (message) => log({ level: 'error', msg: 'otlp export failed', error: message }),
  });
  const clients = new Map<string, BrevoClient>();
  const trackers = new Map<string, EventTracker>();
  const deps: Deps = {
    clientFor: (a) => clients.get(a.name) ?? clients.set(a.name, new BrevoClient({ apiKey: a.apiKey })).get(a.name)!,
    telemetry, now: () => new Date(), log,
    logs: cfg.events.enabled ? logs : undefined,
    trackerFor: (a) => trackers.get(a.name) ?? trackers.set(a.name, new EventTracker(cfg.events.statePath ? `${cfg.events.statePath}.${a.name}.json` : undefined)).get(a.name)!,
  };
  const evState = newEventsState();
  const cycle = async () => { await pollOnce(cfg, deps); await pollEvents(cfg, deps, evState); };

  if (values.once) {
    const r = await pollOnce(cfg, deps);
    await pollEvents(cfg, deps, evState);
    await telemetry.flush(); await logs.flush(); await telemetry.shutdown(); await logs.shutdown();
    process.exit(r.ok === 0 || telemetry.exportFailures() > 0 ? 1 : 0);
  }

  const ac = new AbortController();
  process.on('SIGTERM', () => ac.abort()); process.on('SIGINT', () => ac.abort());
  log({ level: 'info', msg: 'started', accounts: cfg.accounts.length, intervalSeconds: cfg.intervalSeconds });
  await runLoop(cycle, cfg.intervalSeconds, ac.signal);
  log({ level: 'info', msg: 'stopped' });
  await telemetry.flush(); await logs.flush(); await telemetry.shutdown(); await logs.shutdown();
}

/** Polls until aborted. The sleep keeps the event loop alive and wakes immediately on abort. */
export async function runLoop(poll: () => Promise<void>, intervalSeconds: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await poll();
    if (signal.aborted) return;
    try { await sleep(intervalSeconds * 1000, undefined, { signal }); }
    catch (e) { if ((e as Error).name !== 'AbortError') throw e; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((e) => { process.stderr.write(`fatal: ${(e as Error).name}\n`); process.exit(1); });
}
