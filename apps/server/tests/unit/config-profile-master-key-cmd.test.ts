// PROFILE_MASTER_KEY_CMD — provider-agnostic master-key sourcing (KMS hardening).
// When set, the command's stdout IS the base64 master key (so operators source
// it from any KMS/secret store without an SDK dependency, keeping the key out of
// .env). Fail-closed: a configured-but-failing/empty command must throw, never
// silently fall back. Unset → plaintext PROFILE_MASTER_KEY (today's behavior).

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/config.js';

const base = {
  DATABASE_URL: 'postgres://x@localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
};
const KEY = Buffer.alloc(32, 7).toString('base64'); // valid base64 32-byte key

describe('loadConfig — PROFILE_MASTER_KEY_CMD (KMS-agnostic master key)', () => {
  it('CMD unset → falls back to plaintext PROFILE_MASTER_KEY (unchanged behavior)', () => {
    expect(loadConfig({ ...base, PROFILE_MASTER_KEY: KEY }).profileMasterKey).toBe(KEY);
  });

  it('CMD unset + plaintext unset → profileMasterKey undefined (feature inert)', () => {
    expect(loadConfig({ ...base }).profileMasterKey).toBeUndefined();
  });

  it('CMD set → its stdout is used as the key (trimmed), overriding any plaintext', () => {
    const cfg = loadConfig({
      ...base,
      PROFILE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), // different — must be ignored
      PROFILE_MASTER_KEY_CMD: `printf %s ${KEY}`,
    });
    expect(cfg.profileMasterKey).toBe(KEY);
  });

  it('CMD stdout with trailing newline is trimmed before validation', () => {
    const cfg = loadConfig({ ...base, PROFILE_MASTER_KEY_CMD: `printf '%s\\n' ${KEY}` });
    expect(cfg.profileMasterKey).toBe(KEY);
  });

  it('FAIL-CLOSED: a CMD that exits non-zero throws (no silent fallback)', () => {
    expect(() =>
      loadConfig({ ...base, PROFILE_MASTER_KEY: KEY, PROFILE_MASTER_KEY_CMD: 'false' }),
    ).toThrow(/PROFILE_MASTER_KEY_CMD failed/);
  });

  it('FAIL-CLOSED: a CMD that emits nothing throws (empty key)', () => {
    expect(() => loadConfig({ ...base, PROFILE_MASTER_KEY_CMD: 'true' })).toThrow(/empty output/);
  });

  it('a CMD whose output is not a 32-byte base64 key fails the schema refine', () => {
    expect(() =>
      loadConfig({ ...base, PROFILE_MASTER_KEY_CMD: 'printf %s not-a-real-key' }),
    ).toThrow(/32 bytes/);
  });
});
