import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { BrevoClient, BrevoDeliveryEvent } from './brevo.js';

export interface FailureEvent {
  event: string; at: Date; messageId: string; sender: string; subject: string; reason: string; recipientDomain: string;
  /** Short hash of the recipient address: tells two recipients of one message apart. Never exported. */
  fingerprint: string;
}

const MAX_REASON = 500;
const EMAIL = /[^\s<>"'@,;()[\]]+@([^\s<>"'(),;[\]]+)/g;

/** Replaces the local part of any email address in free text, keeping the domain. */
export function redact(text: string): string {
  return text.replace(EMAIL, '<redacted>@$1');
}

/** Reduces a Brevo event to what we are willing to export: never a recipient's address. */
export function toFailureEvent(e: BrevoDeliveryEvent, queriedType?: string): FailureEvent {
  const email = (e.email ?? '').toLowerCase();
  const at = email.lastIndexOf('@');
  return {
    event: queriedType ?? e.event,
    at: new Date(e.date),
    messageId: e.messageId,
    sender: e.from ?? '',
    subject: redact(e.subject ?? ''),
    reason: redact(e.reason ?? '').slice(0, MAX_REASON),
    recipientDomain: at >= 0 ? email.slice(at + 1) : '',
    fingerprint: email ? createHash('sha256').update(email).digest('hex').slice(0, 12) : '',
  };
}

export function severityFor(event: string): 'error' | 'warn' {
  return event === 'softBounces' || event === 'deferred' ? 'warn' : 'error';
}

/** Events with an unparseable date are skipped rather than failing the whole poll. */
export async function collectFailures(client: BrevoClient, day: string, types: readonly string[]): Promise<FailureEvent[]> {
  const out: FailureEvent[] = [];
  for (const t of types) {
    for (const e of await client.listEvents(day, t)) {
      const f = toFailureEvent(e, t);
      if (!Number.isNaN(f.at.getTime())) out.push(f);
    }
  }
  return out;
}

interface State { seen: { key: string; day: string }[]; lastDay?: string }

/**
 * Remembers which events were already exported. The very first run (no state yet) is a baseline:
 * existing events are marked as seen without being emitted, so a fresh install does not replay history.
 *
 * Events are staged by `fresh()` and become final with `commit()`; `rollback()` un-sees them again so a
 * failed export is retried (at-least-once delivery).
 */
export class EventTracker {
  private seen = new Map<string, string>();
  private staged: string[] = [];
  private initialized = false;
  private initializedBeforeStage = false;
  /** Set when the state file existed but could not be used. */
  loadWarning?: string;
  /** The last day (query day) that was polled; survives restarts when a state path is configured. */
  lastDay?: string;

  constructor(private readonly statePath?: string) {
    if (statePath && existsSync(statePath)) {
      try {
        const s = JSON.parse(readFileSync(statePath, 'utf8')) as State;
        for (const e of s.seen) this.seen.set(e.key, e.day);
        this.lastDay = s.lastDay;
        this.initialized = true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'EACCES' || code === 'EPERM') {
          this.loadWarning = `state file ${statePath} is not readable (${code}); starting with a baseline`;
        } else {
          try { renameSync(statePath, `${statePath}.corrupt`); } catch { /* best effort */ }
          this.loadWarning = `state file ${statePath} was corrupt and moved to ${statePath}.corrupt; starting with a baseline`;
        }
      }
    }
  }

  fresh(events: FailureEvent[], day: string): FailureEvent[] {
    if (this.staged.length === 0) this.initializedBeforeStage = this.initialized;
    const out: FailureEvent[] = [];
    for (const e of events) {
      const key = `${e.event}|${e.messageId}|${e.fingerprint}|${e.at.toISOString()}`;
      if (this.seen.has(key)) continue;
      this.seen.set(key, day);
      this.staged.push(key);
      if (this.initialized) out.push(e);
    }
    this.initialized = true;
    return out;
  }

  commit(): void { this.staged = []; }

  rollback(): void {
    for (const k of this.staged) this.seen.delete(k);
    this.staged = [];
    this.initialized = this.initializedBeforeStage;
  }

  prune(keepDays: string[]): void {
    for (const [k, d] of this.seen) if (!keepDays.includes(d)) this.seen.delete(k);
  }

  save(): void {
    if (!this.statePath) return;
    const state: State = { seen: [...this.seen].map(([key, day]) => ({ key, day })), lastDay: this.lastDay };
    const tmp = `${this.statePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, this.statePath);
    } catch (e) {
      throw new Error(`cannot write state file ${this.statePath}: ${(e as { code?: string }).code ?? 'error'}`);
    }
  }
}
