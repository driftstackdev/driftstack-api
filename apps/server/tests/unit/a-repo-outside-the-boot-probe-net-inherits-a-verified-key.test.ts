// `agent_turn_receipts` encrypts customer response bodies and is the one
// envelope-bearing repo with NO boot probe of its own. That is safe today for a
// reason nothing in the tree asserts.
//
// `lib/boot-key-verification.ts` states: "Every envelope migration in
// `bootstrap` opens with a probe: read one already-encrypted row with the
// configured key and throw if it cannot be decrypted." Measured 2026-08-28 that
// claim is exact — there are NINE envelope migrations reached from `bootstrap`
// and all nine probe, inside the migration method itself:
//
//   platform-secrets  migrateValueEnvelopes          fleet-nodes  migrateLivekitSecretEnvelopes
//   mfa               migrateTotpSecretEnvelopes     byok         migrateCiphertextEnvelopes
//   recipes           migratePayloadEnvelopes        sessions     migrateTranscriptEnvelopes
//   profiles          migrateWrappedDekEnvelopes     proxies      migrateSecretEnvelopes
//   webhooks          encryptLegacySecrets
//
// ⛔ The probe is attached to the MIGRATION, not to the KEY. A repo that never
// had a legacy envelope to migrate therefore never acquired one —
// `agent-turn-receipts-repo` encrypts through `platform-secret-encryption` and
// has no migration, so it sits outside that net.
//
// The consequence is nil ONLY because of a relationship: bootstrap constructs it
// with `config.mfaEncryptionKey`, the SAME key seven of the nine probes verify.
// A wrong `MFA_ENCRYPTION_KEY` is therefore caught at boot by those seven, and
// this repo never gets the chance to fail at request time with the raw
// "Unsupported state or unable to authenticate data" that the probe wrapper
// exists to replace.
//
// ⚠️ A nil consequence holds only while its invariant does, so this file ASSERTS
// the relationship instead of recording it in prose. Hand this repo its own key,
// or move the probes off `MFA_ENCRYPTION_KEY`, and the inheritance silently ends
// — the code keeps working until the day a key is rotated, which is exactly the
// moment an operator is least able to diagnose it.
//
// WHAT THIS DOES NOT CHECK, stated rather than implied: it reads source text, so
// it verifies which key the constructor is HANDED, not that the key decrypts any
// row. Proving that needs a real database and a real key, which is what the boot
// probe itself does at runtime.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const BOOTSTRAP = resolve(SRC, 'lib', 'bootstrap.ts');
const DB_DIR = resolve(SRC, 'db');
const SUBJECT = resolve(DB_DIR, 'agent-turn-receipts-repo.ts');

/**
 * The comma-separated arguments of the call that follows `marker`, split at
 * paren depth 1 so a nested call in an earlier argument cannot shift the index.
 */
function argsOf(src: string, marker: string): string[] {
  const at = src.indexOf(marker);
  if (at < 0) return [];
  const open = src.indexOf('(', at);
  if (open < 0) return [];
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        out.push(src.slice(start, i));
        break;
      }
    } else if (c === ',' && depth === 1) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return out.map((s) => s.trim());
}

/** Every `verifyBootEncryptionKey('<subsystem>', '<ENV_VAR>'` site under `db/`. */
function probeSites(): { file: string; subsystem: string; envVar: string }[] {
  const found: { file: string; subsystem: string; envVar: string }[] = [];
  for (const file of readdirSync(DB_DIR).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(resolve(DB_DIR, file), 'utf8');
    const re = /verifyBootEncryptionKey\(\s*'([^']+)'\s*,\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      found.push({ file, subsystem: m[1] as string, envVar: m[2] as string });
    }
  }
  return found;
}

describe('a repo outside the boot-probe net inherits a verified key', () => {
  it('CRITICAL the probe census is non-empty and spans both key families. Every arm below is a statement about that census, and a scan that silently matched nothing would satisfy them vacuously — this is the floor that stops it.', () => {
    const sites = probeSites();
    expect(sites.length, 'verifyBootEncryptionKey call sites under db/').toBeGreaterThanOrEqual(8);
    const keys = new Set(sites.map((s) => s.envVar));
    expect(keys, 'the MFA key family is present').toContain('MFA_ENCRYPTION_KEY');
    expect(keys, 'the profile key family is present').toContain('PROFILE_MASTER_KEY');
  });

  it('CRITICAL agent_turn_receipts is constructed with the key the boot probes verify. Its safety is entirely INHERITED — it has no probe of its own, so handing it any other key ends the inheritance without changing a single observable behaviour until a rotation.', () => {
    const boot = readFileSync(BOOTSTRAP, 'utf8');
    const args = argsOf(boot, 'new DrizzleAgentTurnReceiptsRepo');
    expect(args.length, 'the constructor call was located and parsed').toBeGreaterThanOrEqual(2);
    expect(args[1], 'the encryption key handed to DrizzleAgentTurnReceiptsRepo').toBe(
      'config.mfaEncryptionKey',
    );
  });

  it('CRITICAL the inheritance is real — at least one boot probe still verifies MFA_ENCRYPTION_KEY. If the probes move off that key, the arm above keeps passing while the property it stands for is gone; this is the half that notices.', () => {
    const onMfaKey = probeSites().filter((s) => s.envVar === 'MFA_ENCRYPTION_KEY');
    expect(
      onMfaKey.length,
      'subsystems whose boot probe verifies MFA_ENCRYPTION_KEY (the key agent_turn_receipts borrows)',
    ).toBeGreaterThanOrEqual(1);
  });

  it('this guard retires itself. If agent-turn-receipts-repo ever gains its own verifyBootEncryptionKey call it no longer inherits anything, and this file should be DELETED rather than left as a fossil that makes the surface look more examined than it is.', () => {
    const subject = readFileSync(SUBJECT, 'utf8');
    expect(subject.length, 'subject source was read').toBeGreaterThan(1000);
    expect(
      subject.includes('verifyBootEncryptionKey'),
      'agent-turn-receipts-repo still has no boot probe of its own — if this fails, delete this file',
    ).toBe(false);
  });
});
