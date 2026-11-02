import { describe, it, expect } from 'vitest';
import { InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { createTelemetry } from '../src/telemetry.js';
import type { AccountSnapshot } from '../src/snapshot.js';

const otlp = { endpoint: 'http://localhost:4318' };
const snap = (o: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  account: 'main', dailyLimit: 300, sentToday: 168, remaining: 120,
  byApp: new Map([['landgang', 165], ['unattributed', 3]]), ...o,
});

async function run(fn: (t: ReturnType<typeof createTelemetry>) => void) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const t = createTelemetry(otlp, reader);
  fn(t);
  await t.flush();
  const points = new Map<string, { value: number; attrs: Record<string, unknown> }[]>();
  for (const rm of exporter.getMetrics())
    for (const sm of rm.scopeMetrics)
      for (const m of sm.metrics)
        points.set(m.descriptor.name, m.dataPoints.map((d) => ({ value: d.value as number, attrs: d.attributes as Record<string, unknown> })));
  await t.shutdown();
  return points;
}

describe('telemetry', () => {
  it('exports quota gauges with spec names and labels', async () => {
    const p = await run((t) => t.recordSuccess(snap(), new Date('2026-11-02T10:00:00Z')));
    expect(p.get('brevo.email.daily_limit')).toEqual([{ value: 300, attrs: { account: 'main' } }]);
    expect(p.get('brevo.email.sent_today')![0]!.value).toBe(168);
    expect(p.get('brevo.email.remaining')![0]!.value).toBe(120);
    const byApp = p.get('brevo.email.sent_today.by_app')!;
    expect(byApp).toContainEqual({ value: 165, attrs: { account: 'main', app: 'landgang' } });
    expect(byApp).toContainEqual({ value: 3, attrs: { account: 'main', app: 'unattributed' } });
    expect(p.get('brevo.exporter.last_success_timestamp')![0]!.value).toBe(Date.parse('2026-11-02T10:00:00Z') / 1000);
  });
  it('omits remaining when null', async () => {
    const p = await run((t) => t.recordSuccess(snap({ remaining: null }), new Date()));
    expect(p.has('brevo.email.remaining')).toBe(false);
  });
  it('counts errors with account and reason', async () => {
    const p = await run((t) => { t.recordError('main', 'http_429'); t.recordError('main', 'http_429'); });
    expect(p.get('brevo.exporter.poll_errors')).toEqual([{ value: 2, attrs: { account: 'main', reason: 'http_429' } }]);
  });
  it('exports no quota gauges for an account that only errored', async () => {
    const p = await run((t) => t.recordError('main', 'timeout'));
    expect(p.has('brevo.email.sent_today')).toBe(false);
    expect(p.has('brevo.exporter.last_success_timestamp')).toBe(false);
  });
  it('drops apps that disappeared from the latest snapshot', async () => {
    const p = await run((t) => {
      t.recordSuccess(snap(), new Date());
      t.recordSuccess(snap({ byApp: new Map([['unattributed', 0]]) }), new Date());
    });
    expect(p.get('brevo.email.sent_today.by_app')).toEqual([{ value: 0, attrs: { account: 'main', app: 'unattributed' } }]);
  });
});
