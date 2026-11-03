import { LoggerProvider, BatchLogRecordProcessor, type LogRecordProcessor, type LogRecordExporter } from '@opentelemetry/sdk-logs';
import { ExportResultCode } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { buildResource } from './resource.js';
import type { Config } from './config.js';
import { otlpHeaders } from './telemetry.js';

export type Level = 'info' | 'warn' | 'error';
export type Attrs = Record<string, string | number | boolean>;

export interface LogExportState { failures: number; lastError: string }

/** Wraps a log exporter so failed exports are counted instead of vanishing in the SDK. */
export function trackLogExport(inner: LogRecordExporter, state: LogExportState, onError?: (m: string) => void): LogRecordExporter {
  return {
    export(logs, cb) {
      inner.export(logs, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          state.failures++;
          state.lastError = result.error?.message ?? 'export failed';
          onError?.(state.lastError);
        }
        cb(result);
      });
    },
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
    shutdown: () => inner.shutdown(),
  };
}

export interface LogSink {
  /** Number of failed OTLP log exports so far. */
  exportFailures(): number;
  emit(level: Level, body: string, attrs?: Attrs, at?: Date): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const SEVERITY: Record<Level, [SeverityNumber, string]> = {
  info: [SeverityNumber.INFO, 'INFO'],
  warn: [SeverityNumber.WARN, 'WARN'],
  error: [SeverityNumber.ERROR, 'ERROR'],
};

export function createLogSink(otlp: Config['otlp'], processor?: LogRecordProcessor, onExportError?: (m: string) => void): LogSink {
  const state: LogExportState = { failures: 0, lastError: '' };
  const proc = processor ?? new BatchLogRecordProcessor({
    exporter: trackLogExport(new OTLPLogExporter({ url: `${otlp.endpoint.replace(/\/$/, '')}/v1/logs`, headers: otlpHeaders(otlp) }), state, onExportError),
    scheduledDelayMillis: 5_000,
    maxQueueSize: 20_000,          // a backlog after downtime must not overflow the default 2048 and be dropped silently
    maxExportBatchSize: 512,
  });
  const provider = new LoggerProvider({
    resource: buildResource(),
    processors: [proc],
  });
  const logger = provider.getLogger('brevo-otel-exporter');
  return {
    exportFailures: () => state.failures,
    emit(level, body, attrs = {}, at) {
      const [severityNumber, severityText] = SEVERITY[level];
      logger.emit({ severityNumber, severityText, body, attributes: attrs, timestamp: at ?? new Date() });
    },
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

/** A sink that drops everything (logs disabled). */
export const nullSink: LogSink = { exportFailures: () => 0, emit() {}, flush: async () => {}, shutdown: async () => {} };
