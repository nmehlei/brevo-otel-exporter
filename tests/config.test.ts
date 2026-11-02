import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function write(yaml: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'config.yaml');
  writeFileSync(p, yaml);
  return p;
}
const base = (extra = '') => `
otlp:
  endpoint: http://localhost:4318
accounts:
  - name: main
    apiKeyEnv: BREVO_KEY
    dailyLimit: 300
    rules:
      - { app: landgang, tag: landgang }
      - { app: other, subject: "^Hello" }
${extra}`;

describe('loadConfig', () => {
  it('resolves the key from env and defaults the interval to 300', () => {
    const cfg = loadConfig(write(base()), { BREVO_KEY: 'secret-value' });
    expect(cfg.accounts[0]!.apiKey).toBe('secret-value');
    expect(cfg.intervalSeconds).toBe(300);
    expect(cfg.accounts[0]!.rules).toHaveLength(2);
  });
  it('names the missing variable but never a value', () => {
    expect(() => loadConfig(write(base()), {})).toThrow(/BREVO_KEY/);
  });
  it('reads a key from a file and trims it', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'key-')), 'k');
    writeFileSync(f, 'file-secret\n');
    const yaml = base().replace('apiKeyEnv: BREVO_KEY', `apiKeyFile: ${f}`);
    expect(loadConfig(write(yaml), {}).accounts[0]!.apiKey).toBe('file-secret');
  });
  it('rejects an invalid subject regex', () => {
    const yaml = base().replace('"^Hello"', '"(["');
    expect(() => loadConfig(write(yaml), { BREVO_KEY: 'x' })).toThrow(/regex/i);
  });
  it('rejects empty accounts', () => {
    expect(() => loadConfig(write('otlp:\n  endpoint: http://x\naccounts: []\n'), {})).toThrow();
  });
  it('rejects a rule without tag, sender or subject', () => {
    const yaml = base().replace('{ app: landgang, tag: landgang }', '{ app: landgang }');
    expect(() => loadConfig(write(yaml), { BREVO_KEY: 'x' })).toThrow();
  });
});
