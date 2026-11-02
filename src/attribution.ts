import type { AttributionRule } from './config.js';
import type { BrevoEvent } from './brevo.js';

/** Sender/subject rules only; first matching rule wins. Tag rules are counted via the tag report. */
export function classifyEvent(e: BrevoEvent, rules: AttributionRule[]): string | null {
  for (const r of rules) {
    if (r.sender && e.from?.toLowerCase() === r.sender.toLowerCase()) return r.app;
    if (r.subject && new RegExp(r.subject).test(e.subject ?? '')) return r.app;
  }
  return null;
}

export function countByApp(events: BrevoEvent[], rules: AttributionRule[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const app = classifyEvent(e, rules);
    if (app) out.set(app, (out.get(app) ?? 0) + 1);
  }
  return out;
}

export function withUnattributed(byApp: Map<string, number>, total: number): Map<string, number> {
  const sum = [...byApp.values()].reduce((a, b) => a + b, 0);
  const out = new Map(byApp);
  out.set('unattributed', Math.max(0, total - sum));
  return out;
}
