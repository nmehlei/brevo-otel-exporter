import { describe, it, expect } from 'vitest';
import { BrevoClient } from '../src/brevo.js';

const mk = (ids: number[]) => JSON.stringify({ events: ids.map((i) => ({ date: 'd', from: 'f', subject: 's', messageId: `m${i}` })) });
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

describe('event pagination robustness', () => {
  it('dedupes events repeated across pages (offset shift)', async () => {
    const pages = [mk(range(0, 500)), mk(range(499, 520))];   // m499 appears twice
    let n = 0;
    const c = new BrevoClient({ apiKey: 'k', fetch: (async () => new Response(pages[n++]!)) as typeof fetch });
    expect(await c.listSendEvents('2026-11-02')).toHaveLength(520);
  });
  it('stops with an error when the API keeps returning full pages', async () => {
    let n = 0;
    const c = new BrevoClient({ apiKey: 'k', fetch: (async () => new Response(mk(range(n * 500, ++n * 500)))) as typeof fetch });
    await expect(c.listSendEvents('2026-11-02')).rejects.toMatchObject({ reason: 'parse' });
  });
});
