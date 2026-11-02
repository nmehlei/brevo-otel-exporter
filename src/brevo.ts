export interface BrevoEvent { date: string; from: string; subject: string; messageId: string }

export type BrevoErrorReason = 'http_4xx' | 'http_429' | 'http_5xx' | 'timeout' | 'network' | 'parse';

export class BrevoError extends Error {
  constructor(readonly reason: BrevoErrorReason, message: string) {
    super(message);
    this.name = 'BrevoError';
  }
}

const PAGE = 500;

export class BrevoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.brevo.com/v3';
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async get(path: string): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        headers: { 'api-key': this.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new BrevoError('timeout', `Brevo request timed out: ${path.split('?')[0]}`);
      throw new BrevoError('network', `Brevo request failed: ${path.split('?')[0]}`);
    }
    const route = path.split('?')[0];
    if (res.status === 429) throw new BrevoError('http_429', `Brevo rate limited (429): ${route}`);
    if (res.status >= 500) throw new BrevoError('http_5xx', `Brevo server error (${res.status}): ${route}`);
    if (res.status >= 400) throw new BrevoError('http_4xx', `Brevo client error (${res.status}): ${route}`);
    try {
      return JSON.parse(await res.text());
    } catch {
      throw new BrevoError('parse', `Brevo returned invalid JSON: ${route}`);
    }
  }

  async getAccount(): Promise<{ timezone: string; remainingCredits: number | null }> {
    const d = await this.get('/account');
    const plan = Array.isArray(d.plan) ? d.plan.find((p: any) => p?.creditsType === 'sendLimit') : undefined;
    return {
      timezone: d.dateTimePreferences?.timezone ?? 'UTC',
      remainingCredits: typeof plan?.credits === 'number' ? plan.credits : null,
    };
  }

  async getSentCount(day: string, tag?: string): Promise<number> {
    const q = `startDate=${day}&endDate=${day}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`;
    const d = await this.get(`/smtp/statistics/aggregatedReport?${q}`);
    if (typeof d.requests !== 'number') throw new BrevoError('parse', 'Brevo report has no "requests" field');
    return d.requests;
  }

  async listSendEvents(day: string): Promise<BrevoEvent[]> {
    const all: BrevoEvent[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const d = await this.get(`/smtp/statistics/events?startDate=${day}&endDate=${day}&event=requests&limit=${PAGE}&offset=${offset}`);
      const page: any[] = Array.isArray(d.events) ? d.events : [];
      for (const e of page) all.push({ date: e.date, from: e.from, subject: e.subject, messageId: e.messageId });
      if (page.length < PAGE) return all;
    }
  }
}
