import { describe, it, expect } from 'vitest';
import { runLoop } from '../src/main.js';

describe('runLoop', () => {
  it('keeps polling until aborted, even when the sleep timer is the only handle', async () => {
    const ac = new AbortController();
    let polls = 0;
    await runLoop(async () => { polls++; if (polls === 3) ac.abort(); }, 0.01, ac.signal);
    expect(polls).toBe(3);
  });
  it('returns promptly when aborted during a poll, without sleeping a full interval', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    await runLoop(async () => { ac.abort(); }, 300, ac.signal);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('does not poll at all when already aborted', async () => {
    const ac = new AbortController(); ac.abort();
    let polls = 0;
    await runLoop(async () => { polls++; }, 1, ac.signal);
    expect(polls).toBe(0);
  });
});
