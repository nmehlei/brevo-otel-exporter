#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';
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

export interface EventsState { lastRun: Map<string, number> }
export const newEventsState = (): EventsState => ({ lastRun: new Map() });

class LogExportError extends Error {}

/**
 * Exports Brevo delivery failures as log records and today's failure counts as a metric.
 * Delivery is at-least-once: events are only marked as exported (and the state file written) after the
 * OTLP log export succeeded; otherwise they are rolled back and sent again on the next poll.
 */
/** Returns the number of accounts whose events poll failed. */
export async function pollEvents(cfg: Config, deps: Deps, state: EventsState): Promise<number> {
  let failed = 0;
  if (!cfg.events.enabled || !deps.logs || !deps.trackerFor) return 0;
  const nowMs = deps.now().getTime();
  for (const a of cfg.accounts) {
    if (nowMs - (state.lastRun.get(a.name) ?? 0) < cfg.events.intervalSeconds * 1000) continue;
    const tracker = deps.trackerFor(a);
    try {
      const client = deps.clientFor(a);
      const tz = a.timezone ?? (await client.getAccount()).timezone;
      const today = queryDay(deps.now(), tz);
      const prev = tracker.lastDay;
      const days = prev && prev !== today ? [prev, today] : [today];

      // Fetch everything first, so a failure half-way cannot leave some days emitted and others not.
      const fetched: { day: string; events: Awaited<ReturnType<typeof collectFailures>> }[] = [];
      for (const day of days) fetched.push({ day, events: await collectFailures(client, day, cfg.events.types) });

      const failuresBefore = deps.logs.exportFailures();
      const counts = new Map<string, number>(cfg.events.types.map((t) => [t, 0]));
      let emitted = 0;
      for (const { day, events } of fetched) {
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
      if (emitted > 0) {
        await deps.logs.flush();
        if (deps.logs.exportFailures() > failuresBefore) throw new LogExportError('OTLP log export failed');
      }
      tracker.commit();
      tracker.lastDay = today;
      tracker.prune(days);
      tracker.save();
      deps.telemetry.recordFailures(a.name, counts, deps.now());
      state.lastRun.set(a.name, nowMs);
      deps.log({ level: 'info', msg: 'events polled', account: a.name, newFailures: emitted });
    } catch (e) {
      failed++;
      tracker.rollback();
      const reason = e instanceof BrevoError ? e.reason : e instanceof LogExportError ? 'log_export' : 'unexpected';
      deps.telemetry.recordError(a.name, `events_${reason}`);
      const detail = e instanceof BrevoError || e instanceof LogExportError || (e as Error).message?.startsWith('cannot write state file')
        ? (e as Error).message : (e as Error).name;
      deps.log({ level: 'error', msg: 'events poll failed', account: a.name, reason, error: detail });
    }
  }
  return failed;
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

  if (cfg.events.enabled && cfg.events.statePath) {
    try { accessSync(dirname(cfg.events.statePath), constants.W_OK); }
    catch { process.stderr.write(`events.statePath directory is missing or not writable: ${dirname(cfg.events.statePath)}\n`); process.exit(2); }
  }
  if (values.once && cfg.events.enabled && !cfg.events.statePath) {
    process.stderr.write('events.enabled with --once needs events.statePath, otherwise every run is a fresh baseline and no event is ever exported\n');
    process.exit(2);
  }
  const stdout = (e: Record<string, unknown>) => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...e }) + '\n');
  let logs: LogSink = nullSink;
  const log = (e: Record<string, unknown>) => {
    stdout(e);
    if (!cfg.logs) return;
    const { level, msg, ...rest } = e;
    const attrs: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null) attrs[k] = typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean);
    logs.emit(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', String(msg), attrs);
  };
  logs = cfg.logs || cfg.events.enabled ? createLogSink(cfg.otlp, undefined, (message) => stdout({ level: 'error', msg: 'otlp log export failed', error: message })) : nullSink;
  const telemetry = createTelemetry(cfg.otlp, undefined, {
    staleAfterMs: cfg.intervalSeconds * 3 * 1000,
    failuresStaleAfterMs: Math.max(cfg.intervalSeconds, cfg.events.intervalSeconds) * 3 * 1000,
    onExportError: (message) => log({ level: 'error', msg: 'otlp export failed', error: message }),
  });
  const clients = new Map<string, BrevoClient>();
  const trackers = new Map<string, EventTracker>();
  const newTracker = (a: AccountConfig): EventTracker => {
    const t = new EventTracker(cfg.events.statePath ? `${cfg.events.statePath}.${a.name}.json` : undefined);
    if (t.loadWarning) log({ level: 'warn', msg: 'event state problem', account: a.name, detail: t.loadWarning });
    return t;
  };
  const deps: Deps = {
    clientFor: (a) => clients.get(a.name) ?? clients.set(a.name, new BrevoClient({ apiKey: a.apiKey })).get(a.name)!,
    telemetry, now: () => new Date(), log,
    logs: cfg.events.enabled ? logs : undefined,
    trackerFor: (a) => trackers.get(a.name) ?? trackers.set(a.name, newTracker(a)).get(a.name)!,
  };
  const evState = newEventsState();
  const cycle = async () => { await pollOnce(cfg, deps); await pollEvents(cfg, deps, evState); };

  if (values.once) {
    const r = await pollOnce(cfg, deps);
    const eventFailures = await pollEvents(cfg, deps, evState);
    await telemetry.flush(); await logs.flush(); await telemetry.shutdown(); await logs.shutdown();
    process.exit(r.ok === 0 || eventFailures > 0 || telemetry.exportFailures() + logs.exportFailures() > 0 ? 1 : 0);
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
