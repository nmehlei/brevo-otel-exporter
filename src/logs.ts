import { LoggerProvider, BatchLogRecordProcessor, type LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Config } from './config.js';
import { otlpHeaders } from './telemetry.js';

export type Level = 'info' | 'warn' | 'error';
export type Attrs = Record<string, string | number | boolean>;

export interface LogSink {
  emit(level: Level, body: string, attrs?: Attrs, at?: Date): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const SEVERITY: Record<Level, [SeverityNumber, string]> = {
  info: [SeverityNumber.INFO, 'INFO'],
  warn: [SeverityNumber.WARN, 'WARN'],
  error: [SeverityNumber.ERROR, 'ERROR'],
};

export function createLogSink(otlp: Config['otlp'], processor?: LogRecordProcessor): LogSink {
  const proc = processor ?? new BatchLogRecordProcessor({
    exporter: new OTLPLogExporter({ url: `${otlp.endpoint.replace(/\/$/, '')}/v1/logs`, headers: otlpHeaders(otlp) }),
    scheduledDelayMillis: 5_000,
  });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': 'brevo-otel-exporter' }),
    processors: [proc],
  });
  const logger = provider.getLogger('brevo-otel-exporter');
  return {
    emit(level, body, attrs = {}, at) {
      const [severityNumber, severityText] = SEVERITY[level];
      logger.emit({ severityNumber, severityText, body, attributes: attrs, timestamp: at ?? new Date() });
    },
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

/** A sink that drops everything (logs disabled). */
export const nullSink: LogSink = { emit() {}, flush: async () => {}, shutdown: async () => {} };
