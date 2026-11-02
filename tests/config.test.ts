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
  it('rejects an unknown timezone', () => {
    const yaml = base().replace('dailyLimit: 300', 'dailyLimit: 300\n    timezone: Mars/Base');
    expect(() => loadConfig(write(yaml), { BREVO_KEY: 'x' })).toThrow(/timezone/i);
  });
  it('rejects duplicate account names', () => {
    const yaml = `otlp: { endpoint: "http://x" }
accounts:
  - { name: a, apiKeyEnv: K, dailyLimit: 300 }
  - { name: a, apiKeyEnv: K, dailyLimit: 300 }
`;
    expect(() => loadConfig(write(yaml), { K: 'x' })).toThrow(/duplicate/i);
  });
  it('rejects apiKeyEnv together with apiKeyFile', () => {
    const yaml = base().replace('apiKeyEnv: BREVO_KEY', 'apiKeyEnv: BREVO_KEY\n    apiKeyFile: /x');
    expect(() => loadConfig(write(yaml), { BREVO_KEY: 'x' })).toThrow(/either/i);
  });
  it('rejects a username without a password', () => {
    const yaml = base().replace('endpoint: http://localhost:4318', 'endpoint: http://localhost:4318\n  username: u');
    expect(() => loadConfig(write(yaml), { BREVO_KEY: 'x' })).toThrow(/username|password/i);
  });
  it('strips a trailing /v1/metrics from the endpoint', () => {
    const yaml = base().replace('http://localhost:4318', 'http://localhost:4318/v1/metrics');
    expect(loadConfig(write(yaml), { BREVO_KEY: 'x' }).otlp.endpoint).toBe('http://localhost:4318');
  });
  it('does not echo YAML source text on a syntax error', () => {
    expect(() => loadConfig(write('otlp: [unclosed token-ABC123'), {})).toThrow(/yaml/i);
    try { loadConfig(write('otlp: [unclosed token-ABC123'), {}); } catch (e) { expect(String(e)).not.toContain('token-ABC123'); }
  });
});
