#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { BrevoClient, BrevoError } from './brevo.js';
import { loadConfig, type AccountConfig, type Config } from './config.js';
import { takeSnapshot } from './snapshot.js';
import { createTelemetry, type Telemetry } from './telemetry.js';

export interface Deps {
  clientFor(a: AccountConfig): BrevoClient;
  telemetry: Telemetry;
  now(): Date;
  log(e: Record<string, unknown>): void;
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

const USAGE = `Usage: brevo-quota-otel --config <path> [--once]

  --config  path to the YAML config (see examples/config.yaml)
  --once    poll once, flush metrics and exit (exit 1 if every account failed)
`;

async function cli(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help || !values.config) { process.stdout.write(USAGE); process.exit(values.help ? 0 : 2); }
  const log = (e: Record<string, unknown>) => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...e }) + '\n');

  let cfg: Config;
  try { cfg = loadConfig(values.config!, process.env); }
  catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exit(2); }

  const telemetry = createTelemetry(cfg.otlp, undefined, {
    staleAfterMs: cfg.intervalSeconds * 3 * 1000,
    onExportError: (message) => log({ level: 'error', msg: 'otlp export failed', error: message }),
  });
  const clients = new Map<string, BrevoClient>();
  const deps: Deps = {
    clientFor: (a) => clients.get(a.name) ?? clients.set(a.name, new BrevoClient({ apiKey: a.apiKey })).get(a.name)!,
    telemetry, now: () => new Date(), log,
  };

  if (values.once) {
    const r = await pollOnce(cfg, deps);
    await telemetry.flush(); await telemetry.shutdown();
    process.exit(r.ok === 0 || telemetry.exportFailures() > 0 ? 1 : 0);
  }

  const ac = new AbortController();
  process.on('SIGTERM', () => ac.abort()); process.on('SIGINT', () => ac.abort());
  log({ level: 'info', msg: 'started', accounts: cfg.accounts.length, intervalSeconds: cfg.intervalSeconds });
  await runLoop(async () => { await pollOnce(cfg, deps); }, cfg.intervalSeconds, ac.signal);
  await telemetry.flush(); await telemetry.shutdown();
  log({ level: 'info', msg: 'stopped' });
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
