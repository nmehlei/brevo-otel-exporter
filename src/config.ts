import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export interface AttributionRule { app: string; tag?: string; sender?: string; subject?: string }
export interface AccountConfig {
  name: string; apiKey: string; dailyLimit: number; timezone?: string; rules: AttributionRule[];
}
export const FAILURE_EVENT_TYPES = ['hardBounces', 'softBounces', 'blocked', 'spam', 'deferred', 'invalid', 'error'] as const;
export type FailureEventType = (typeof FAILURE_EVENT_TYPES)[number];
export interface EventsConfig {
  enabled: boolean; types: FailureEventType[]; intervalSeconds: number; statePath?: string;
  includeSubject: boolean; includeRecipientDomain: boolean;
}

export interface Config {
  events: EventsConfig;
  /** Also export the exporter's own log lines over OTLP. */
  logs: boolean;
  accounts: AccountConfig[];
  intervalSeconds: number;
  otlp: { endpoint: string; username?: string; password?: string; headers?: Record<string, string> };
}

const rule = z.object({
  app: z.string().min(1),
  tag: z.string().min(1).optional(),
  sender: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
}).refine((r) => r.tag || r.sender || r.subject, { message: 'rule needs tag, sender or subject' })
  .refine((r) => {
    if (!r.subject) return true;
    try { new RegExp(r.subject); return true; } catch { return false; }
  }, { message: 'invalid subject regex' });

const account = z.object({
  name: z.string().min(1),
  apiKeyEnv: z.string().optional(),
  apiKeyFile: z.string().optional(),
  dailyLimit: z.number().int().positive(),
  timezone: z.string().refine((tz) => {
    try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
  }, { message: 'unknown timezone' }).optional(),
  rules: z.array(rule).default([]),
}).refine((a) => !!a.apiKeyEnv !== !!a.apiKeyFile, { message: 'set either apiKeyEnv or apiKeyFile (exactly one)' });

const events = z.object({
  enabled: z.boolean().default(false),
  types: z.array(z.enum(FAILURE_EVENT_TYPES)).min(1).default([...FAILURE_EVENT_TYPES]),
  intervalSeconds: z.number().int().min(60).default(900),
  statePath: z.string().optional(),
  includeSubject: z.boolean().default(true),
  includeRecipientDomain: z.boolean().default(true),
}).default({ enabled: false, types: [...FAILURE_EVENT_TYPES], intervalSeconds: 900, includeSubject: true, includeRecipientDomain: true });

const schema = z.object({
  events,
  logs: z.boolean().default(true),
  intervalSeconds: z.number().int().min(30).default(300),
  otlp: z.object({
    endpoint: z.string().url(),
    username: z.string().optional(),
    passwordEnv: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  accounts: z.array(account).min(1).refine((l) => new Set(l.map((a) => a.name)).size === l.length, { message: 'duplicate account names' }),
}).refine((c) => !!c.otlp.username === !!c.otlp.passwordEnv, { message: 'otlp.username and otlp.passwordEnv must be set together' });

export function loadConfig(path: string, env: NodeJS.ProcessEnv): Config {
  let raw: unknown;
  try { raw = parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`Invalid YAML in config file: ${(e as { code?: string }).code ?? 'syntax error'}`); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const c = parsed.data;
  const accounts = c.accounts.map((a): AccountConfig => {
    let apiKey: string | undefined;
    if (a.apiKeyEnv) {
      apiKey = env[a.apiKeyEnv];
      if (!apiKey) throw new Error(`Account "${a.name}": environment variable ${a.apiKeyEnv} is not set`);
    } else if (a.apiKeyFile) {
      apiKey = readFileSync(a.apiKeyFile, 'utf8').trim();
      if (!apiKey) throw new Error(`Account "${a.name}": key file is empty`);
    }
    return { name: a.name, apiKey: apiKey!, dailyLimit: a.dailyLimit, timezone: a.timezone, rules: a.rules };
  });
  const password = c.otlp.passwordEnv ? env[c.otlp.passwordEnv] : undefined;
  if (c.otlp.passwordEnv && !password) throw new Error(`OTLP password variable ${c.otlp.passwordEnv} is not set`);
  return {
    accounts,
    events: c.events,
    logs: c.logs,
    intervalSeconds: c.intervalSeconds,
    otlp: { endpoint: c.otlp.endpoint.replace(/\/(v1\/metrics)?\/?$/, ''), username: c.otlp.username, password, headers: c.otlp.headers },
  };
}
