import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Config } from './config.js';
import type { AccountSnapshot } from './snapshot.js';

export interface Telemetry {
  recordSuccess(s: AccountSnapshot, at: Date): void;
  recordError(account: string, reason: string): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createTelemetry(otlp: Config['otlp'], reader?: MetricReader, intervalMs = 60_000): Telemetry {
  const headers: Record<string, string> = { ...(otlp.headers ?? {}) };
  if (otlp.username && otlp.password) {
    headers['Authorization'] = `Basic ${Buffer.from(`${otlp.username}:${otlp.password}`).toString('base64')}`;
  }
  const metricReader = reader ?? new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${otlp.endpoint.replace(/\/$/, '')}/v1/metrics`, headers }),
    exportIntervalMillis: intervalMs,
  });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'brevo-quota-otel' }),
    readers: [metricReader],
  });
  const meter = provider.getMeter('brevo-quota-otel');

  const latest = new Map<string, { snap: AccountSnapshot; at: Date }>();

  const gauge = (name: string, description: string, unit: string,
    each: (s: AccountSnapshot, at: Date) => { value: number; attrs: Record<string, string> }[]) => {
    meter.createObservableGauge(name, { description, unit }).addCallback((r) => {
      for (const { snap, at } of latest.values())
        for (const p of each(snap, at)) r.observe(p.value, p.attrs);
    });
  };
  gauge('brevo.email.daily_limit', 'Configured daily send limit', '{email}', (s) => [{ value: s.dailyLimit, attrs: { account: s.account } }]);
  gauge('brevo.email.sent_today', 'Emails sent today (account timezone)', '{email}', (s) => [{ value: s.sentToday, attrs: { account: s.account } }]);
  gauge('brevo.email.remaining', 'Remaining sends according to Brevo', '{email}', (s) =>
    s.remaining === null ? [] : [{ value: s.remaining, attrs: { account: s.account } }]);
  gauge('brevo.email.sent_today.by_app', 'Emails sent today per application', '{email}', (s) =>
    [...s.byApp].map(([app, value]) => ({ value, attrs: { account: s.account, app } })));
  gauge('brevo.exporter.last_success_timestamp', 'Unix time of the last successful poll', 's', (s, at) =>
    [{ value: at.getTime() / 1000, attrs: { account: s.account } }]);

  const errors = meter.createCounter('brevo.exporter.poll_errors', { description: 'Failed polls', unit: '{error}' });

  return {
    recordSuccess: (s, at) => { latest.set(s.account, { snap: s, at }); },
    recordError: (account, reason) => { errors.add(1, { account, reason }); },
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
