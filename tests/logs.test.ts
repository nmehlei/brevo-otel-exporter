import { describe, it, expect } from 'vitest';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { createLogSink } from '../src/logs.js';

function setup() {
  const exporter = new InMemoryLogRecordExporter();
  const sink = createLogSink({ endpoint: 'http://x' }, new SimpleLogRecordProcessor({ exporter }));
  return { exporter, sink };
}

describe('log sink', () => {
  it('exports severity, body and attributes', async () => {
    const { exporter, sink } = setup();
    sink.emit('error', 'Brevo delivery problem: error', { 'brevo.event': 'error', n: 3, ok: false });
    await sink.flush();
    const r = exporter.getFinishedLogRecords()[0]!;
    expect(r.severityText).toBe('ERROR');
    expect(r.body).toBe('Brevo delivery problem: error');
    expect(r.attributes).toMatchObject({ 'brevo.event': 'error', n: 3, ok: false });
    await sink.shutdown();
  });
  it('uses the given timestamp and maps warn/info', async () => {
    const { exporter, sink } = setup();
    const at = new Date('2026-11-02T09:43:00Z');
    sink.emit('warn', 'w', {}, at); sink.emit('info', 'i');
    await sink.flush();
    const [w, i] = exporter.getFinishedLogRecords();
    expect(w!.severityText).toBe('WARN');
    expect(w!.hrTime[0]).toBe(Math.floor(at.getTime() / 1000));
    expect(i!.severityText).toBe('INFO');
    await sink.shutdown();
  });
  it('tags the service name on the resource', async () => {
    const { exporter, sink } = setup();
    sink.emit('info', 'x'); await sink.flush();
    expect(exporter.getFinishedLogRecords()[0]!.resource.attributes['service.name']).toBe('brevo-otel-exporter');
    await sink.shutdown();
  });
});
