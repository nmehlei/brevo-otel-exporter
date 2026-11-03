import { describe, it, expect } from 'vitest';
import { InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { ExportResultCode } from '@opentelemetry/core';
import { createTelemetry, trackExport } from '../src/telemetry.js';
import type { AccountSnapshot } from '../src/snapshot.js';

const snap: AccountSnapshot = { account: 'main', dailyLimit: 300, sentToday: 5, remaining: 100, byApp: new Map([['a', 5]]), overAttributed: 0 };

async function names(nowMs: number, at: Date) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const t = createTelemetry({ endpoint: 'http://x' }, reader, { staleAfterMs: 900_000, now: () => nowMs });
  t.recordSuccess(snap, at);
  await t.flush();
  const out = new Set<string>();
  for (const rm of exporter.getMetrics()) for (const sm of rm.scopeMetrics) for (const m of sm.metrics) if (m.dataPoints.length) out.add(m.descriptor.name);
  await t.shutdown();
  return out;
}

describe('stale snapshots', () => {
  const at = new Date('2026-11-02T10:00:00Z');
  it('exports quota gauges while the snapshot is fresh', async () => {
    expect((await names(at.getTime() + 60_000, at)).has('brevo.email.sent_today')).toBe(true);
  });
  it('drops quota gauges but keeps last_success_timestamp once stale', async () => {
    const n = await names(at.getTime() + 3_600_000, at);
    expect(n.has('brevo.email.sent_today')).toBe(false);
    expect(n.has('brevo.email.sent_today.by_app')).toBe(false);
    expect(n.has('brevo.exporter.last_success_timestamp')).toBe(true);
  });
});

describe('failure counts freshness', () => {
  it('uses its own (longer) window so the gauge does not flap between events polls', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const at = new Date('2026-11-02T10:00:00Z');
    const t = createTelemetry({ endpoint: 'http://x' }, reader, { staleAfterMs: 900_000, failuresStaleAfterMs: 3 * 3_600_000, now: () => at.getTime() + 2 * 3_600_000 });
    t.recordFailures('main', new Map([['error', 1]]), at);
    await t.flush();
    const names = new Set<string>();
    for (const rm of exporter.getMetrics()) for (const sm of rm.scopeMetrics) for (const m of sm.metrics) if (m.dataPoints.length) names.add(m.descriptor.name);
    expect(names.has('brevo.email.failed_today')).toBe(true);
    await t.shutdown();
  });
});

describe('trackExport', () => {
  it('counts failed exports and passes results through', async () => {
    const inner = { export: (_m: unknown, cb: (r: { code: number; error?: Error }) => void) => cb({ code: ExportResultCode.FAILED, error: new Error('401') }),
      forceFlush: async () => {}, shutdown: async () => {} };
    const state = { failures: 0, lastError: '' };
    const wrapped = trackExport(inner as never, state);
    const res = await new Promise<{ code: number }>((r) => wrapped.export({} as never, r));
    expect(res.code).toBe(ExportResultCode.FAILED);
    expect(state.failures).toBe(1);
    expect(state.lastError).toContain('401');
  });
});
