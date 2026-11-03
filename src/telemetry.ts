import { MeterProvider, PeriodicExportingMetricReader, type MetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { ExportResultCode } from '@opentelemetry/core';
import { buildResource } from './resource.js';
import type { Config } from './config.js';
import type { AccountSnapshot } from './snapshot.js';

export function otlpHeaders(otlp: Config['otlp']): Record<string, string> {
  const headers: Record<string, string> = { ...(otlp.headers ?? {}) };
  if (otlp.username && otlp.password) {
    headers['Authorization'] = `Basic ${Buffer.from(`${otlp.username}:${otlp.password}`).toString('base64')}`;
  }
  return headers;
}

export interface Telemetry {
  /** Failure events seen today per type (zeros included for configured types). */
  recordFailures(account: string, counts: Map<string, number>, at: Date): void;
  recordSuccess(s: AccountSnapshot, at: Date): void;
  recordError(account: string, reason: string): void;
  /** Number of failed OTLP exports so far. */
  exportFailures(): number;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  intervalMs?: number;
  /** Quota gauges of an account are dropped when its last good poll is older than this. */
  staleAfterMs?: number;
  /** Failure counts are refreshed only every events interval, so they get their own (longer) window. */
  failuresStaleAfterMs?: number;
  now?: () => number;
  onExportError?: (message: string) => void;
}

export interface ExportState { failures: number; lastError: string }

/** Wraps an exporter so failed exports are counted and surfaced instead of vanishing in the SDK. */
export function trackExport(inner: PushMetricExporter, state: ExportState, onError?: (m: string) => void): PushMetricExporter {
  return {
    export(metrics, cb) {
      inner.export(metrics, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          state.failures++;
          state.lastError = result.error?.message ?? 'export failed';
          onError?.(state.lastError);
        }
        cb(result);
      });
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
    selectAggregationTemporality: inner.selectAggregationTemporality?.bind(inner),
    selectAggregation: inner.selectAggregation?.bind(inner),
  };
}

export function createTelemetry(otlp: Config['otlp'], reader?: MetricReader, opts: TelemetryOptions = {}): Telemetry {
  const now = opts.now ?? Date.now;
  const staleAfterMs = opts.staleAfterMs ?? 15 * 60_000;
  const state: ExportState = { failures: 0, lastError: '' };

  const headers = otlpHeaders(otlp);
  const metricReader = reader ?? new PeriodicExportingMetricReader({
    exporter: trackExport(new OTLPMetricExporter({ url: `${otlp.endpoint.replace(/\/$/, '')}/v1/metrics`, headers }), state, opts.onExportError),
    exportIntervalMillis: opts.intervalMs ?? 60_000,
  });
  const provider = new MeterProvider({
    resource: buildResource(),
    readers: [metricReader],
  });
  const meter = provider.getMeter('brevo-otel-exporter');

  const latest = new Map<string, { snap: AccountSnapshot; at: Date }>();
  const failures = new Map<string, { counts: Map<string, number>; at: Date }>();
  const fresh = (at: Date) => now() - at.getTime() <= staleAfterMs;

  const gauge = (name: string, description: string, unit: string, alwaysExport: boolean,
    each: (s: AccountSnapshot, at: Date) => { value: number; attrs: Record<string, string> }[]) => {
    meter.createObservableGauge(name, { description, unit }).addCallback((r) => {
      for (const { snap, at } of latest.values()) {
        if (!alwaysExport && !fresh(at)) continue;
        for (const p of each(snap, at)) r.observe(p.value, p.attrs);
      }
    });
  };
  gauge('brevo.email.daily_limit', 'Configured daily send limit', '{email}', false, (s) => [{ value: s.dailyLimit, attrs: { account: s.account } }]);
  gauge('brevo.email.sent_today', 'Emails sent today (account timezone)', '{email}', false, (s) => [{ value: s.sentToday, attrs: { account: s.account } }]);
  gauge('brevo.email.remaining', 'Remaining sends according to Brevo', '{email}', false, (s) =>
    s.remaining === null ? [] : [{ value: s.remaining, attrs: { account: s.account } }]);
  gauge('brevo.email.sent_today.by_app', 'Emails sent today per application', '{email}', false, (s) =>
    [...s.byApp].map(([app, value]) => ({ value, attrs: { account: s.account, app } })));
  gauge('brevo.exporter.last_success_timestamp', 'Unix time of the last successful poll', 's', true, (s, at) =>
    [{ value: at.getTime() / 1000, attrs: { account: s.account } }]);

  meter.createObservableGauge('brevo.email.failed_today', { description: 'Failure events seen today per type', unit: '{email}' }).addCallback((r) => {
    for (const [account, { counts, at }] of failures) {
      if (now() - at.getTime() > (opts.failuresStaleAfterMs ?? staleAfterMs)) continue;
      for (const [event, value] of counts) r.observe(value, { account, event });
    }
  });

  const errors = meter.createCounter('brevo.exporter.poll_errors', { description: 'Failed polls (per process lifetime)', unit: '{error}' });

  return {
    recordSuccess: (s, at) => { latest.set(s.account, { snap: s, at }); },
    recordFailures: (account, counts, at) => { failures.set(account, { counts, at }); },
    recordError: (account, reason) => { errors.add(1, { account, reason }); },
    exportFailures: () => state.failures,
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
