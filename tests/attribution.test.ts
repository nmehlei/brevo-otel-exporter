import { describe, it, expect } from 'vitest';
import { classifyEvent, countByApp, withUnattributed } from '../src/attribution.js';
import type { BrevoEvent } from '../src/brevo.js';

const ev = (from: string, subject: string): BrevoEvent => ({ date: 'd', from, subject, messageId: subject + from });
const rules = [
  { app: 'news', sender: 'News@Example.com' },
  { app: 'reports', subject: '^Weekly' },
];

describe('attribution', () => {
  it('matches sender case-insensitively', () => expect(classifyEvent(ev('news@example.com', 'x'), rules)).toBe('news'));
  it('matches subject by regex', () => expect(classifyEvent(ev('a@b.c', 'Weekly report'), rules)).toBe('reports'));
  it('first matching rule wins, so an event is counted once', () => {
    expect(classifyEvent(ev('news@example.com', 'Weekly digest'), rules)).toBe('news');
  });
  it('returns null without a match', () => expect(classifyEvent(ev('a@b.c', 'Hi'), rules)).toBeNull());
  it('ignores tag-only rules', () => expect(classifyEvent(ev('a@b.c', 'Hi'), [{ app: 't', tag: 'x' }])).toBeNull());
  it('counts per app', () => {
    const m = countByApp([ev('news@example.com', 'a'), ev('a@b.c', 'Weekly 1'), ev('a@b.c', 'Weekly 2'), ev('z@z.z', 'q')], rules);
    expect(Object.fromEntries(m)).toEqual({ news: 1, reports: 2 });
  });
  it('adds unattributed so the sum reconciles', () => {
    const m = withUnattributed(new Map([['a', 3], ['b', 2]]), 10);
    expect(m.get('unattributed')).toBe(5);
  });
  it('never reports negative unattributed', () => {
    expect(withUnattributed(new Map([['a', 12]]), 10).get('unattributed')).toBe(0);
  });
});
