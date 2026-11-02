import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { BrevoClient, BrevoDeliveryEvent } from './brevo.js';

export interface FailureEvent {
  event: string; at: Date; messageId: string; sender: string; subject: string; reason: string; recipientDomain: string;
}

const MAX_REASON = 500;

/** Reduces a Brevo event to what we are willing to export: never the recipient's local part. */
export function toFailureEvent(e: BrevoDeliveryEvent): FailureEvent {
  const at = e.email?.lastIndexOf('@') ?? -1;
  return {
    event: e.event,
    at: new Date(e.date),
    messageId: e.messageId,
    sender: e.from ?? '',
    subject: e.subject ?? '',
    reason: (e.reason ?? '').slice(0, MAX_REASON),
    recipientDomain: at >= 0 ? e.email!.slice(at + 1).toLowerCase() : '',
  };
}

export function severityFor(event: string): 'error' | 'warn' {
  return event === 'softBounces' || event === 'deferred' ? 'warn' : 'error';
}

export async function collectFailures(client: BrevoClient, day: string, types: readonly string[]): Promise<FailureEvent[]> {
  const out: FailureEvent[] = [];
  for (const t of types) for (const e of await client.listEvents(day, t)) out.push(toFailureEvent(e));
  return out;
}

interface State { seen: { key: string; day: string }[] }

/**
 * Remembers which events were already exported. The very first run (no state yet) is a baseline:
 * existing events are marked seen without being emitted, so a fresh install does not replay history.
 */
export class EventTracker {
  private seen = new Map<string, string>();
  private initialized = false;

  constructor(private readonly statePath?: string) {
    if (statePath && existsSync(statePath)) {
      try {
        const s = JSON.parse(readFileSync(statePath, 'utf8')) as State;
        for (const e of s.seen) this.seen.set(e.key, e.day);
        this.initialized = true;
      } catch { /* corrupt state: start with a baseline */ }
    }
  }

  fresh(events: FailureEvent[], day: string): FailureEvent[] {
    const out: FailureEvent[] = [];
    for (const e of events) {
      const key = `${e.event}|${e.messageId}|${e.at.toISOString()}`;
      if (this.seen.has(key)) continue;
      this.seen.set(key, day);
      if (this.initialized) out.push(e);
    }
    this.initialized = true;
    return out;
  }

  prune(keepDays: string[]): void {
    for (const [k, d] of this.seen) if (!keepDays.includes(d)) this.seen.delete(k);
  }

  save(): void {
    if (!this.statePath) return;
    const state: State = { seen: [...this.seen].map(([key, day]) => ({ key, day })) };
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.statePath);
  }
}
