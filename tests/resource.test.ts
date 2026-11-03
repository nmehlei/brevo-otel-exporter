import { describe, it, expect } from 'vitest';
import { buildResource } from '../src/resource.js';

describe('buildResource', () => {
  it('defaults the service name', () => {
    expect(buildResource({}).attributes['service.name']).toBe('brevo-otel-exporter');
  });
  it('reads OTEL_RESOURCE_ATTRIBUTES (comma separated, percent decoded)', () => {
    const r = buildResource({ OTEL_RESOURCE_ATTRIBUTES: 'nme_tenant=nme, deployment.environment=prod%20eu' });
    expect(r.attributes['nme_tenant']).toBe('nme');
    expect(r.attributes['deployment.environment']).toBe('prod eu');
  });
  it('lets OTEL_SERVICE_NAME and the attributes override the default', () => {
    expect(buildResource({ OTEL_SERVICE_NAME: 'x' }).attributes['service.name']).toBe('x');
    expect(buildResource({ OTEL_RESOURCE_ATTRIBUTES: 'service.name=y' }).attributes['service.name']).toBe('y');
  });
  it('ignores malformed pairs', () => {
    const r = buildResource({ OTEL_RESOURCE_ATTRIBUTES: 'novalue,=x,ok=1' });
    expect(r.attributes['ok']).toBe('1');
    expect(Object.keys(r.attributes)).not.toContain('novalue');
  });
});
