import { resourceFromAttributes } from '@opentelemetry/resources';

function decode(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

/** Resource for every signal: service name default, overridable through the standard OTEL_* variables. */
export function buildResource(env: NodeJS.ProcessEnv = process.env) {
  const attrs: Record<string, string> = { 'service.name': 'brevo-otel-exporter' };
  for (const pair of (env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (key) attrs[key] = decode(pair.slice(eq + 1).trim());
  }
  if (env.OTEL_SERVICE_NAME) attrs['service.name'] = env.OTEL_SERVICE_NAME;
  return resourceFromAttributes(attrs);
}
