import type { BrevoClient } from './brevo.js';
import type { AccountConfig } from './config.js';
import { countByApp, withUnattributed } from './attribution.js';

export interface AccountSnapshot {
  account: string; dailyLimit: number; sentToday: number; remaining: number | null; byApp: Map<string, number>;
  /** Mails counted by more than one rule (sum of per-app counts minus sentToday, if positive). */
  overAttributed: number;
}

export function localDay(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * The day to ask Brevo for: the account's local day, but never later than Brevo's own (UTC) date,
 * because the API rejects future dates with a 400. Around local midnight (00:00 to 01:00 or 02:00 in
 * Berlin) this means the previous day's report is still shown.
 */
export function queryDay(now: Date, timezone: string): string {
  const local = localDay(now, timezone);
  const utc = localDay(now, 'UTC');
  return local > utc ? utc : local;
}

export async function takeSnapshot(client: BrevoClient, cfg: AccountConfig, now: Date): Promise<AccountSnapshot> {
  const acct = await client.getAccount();
  const day = queryDay(now, cfg.timezone ?? acct.timezone);
  const sentToday = await client.getSentCount(day);

  const byApp = new Map<string, number>();
  for (const r of cfg.rules) {
    if (r.tag) byApp.set(r.app, (byApp.get(r.app) ?? 0) + (await client.getSentCount(day, r.tag)));
  }
  const eventRules = cfg.rules.filter((r) => r.sender || r.subject);
  if (eventRules.length > 0) {
    for (const r of eventRules) if (!byApp.has(r.app)) byApp.set(r.app, 0);
    for (const [app, n] of countByApp(await client.listSendEvents(day), eventRules)) {
      byApp.set(app, (byApp.get(app) ?? 0) + n);
    }
  }
  const attributed = [...byApp.values()].reduce((a, b) => a + b, 0);
  return {
    account: cfg.name,
    dailyLimit: cfg.dailyLimit,
    sentToday,
    remaining: acct.remainingCredits === null ? null : Math.max(0, acct.remainingCredits),
    byApp: withUnattributed(byApp, sentToday),
    overAttributed: Math.max(0, attributed - sentToday),
  };
}
