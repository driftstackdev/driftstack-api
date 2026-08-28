// The seed script's ORDERING is the only thing binding a LiveKit envelope to the
// right fleet node, and nothing downstream can check it.
//
// `scripts/seed-local-fleet-node.ts` is an operator CLI that registers a Mac
// harness node and optionally stores its LiveKit credentials. It is documented for
// PROD ("DATABASE_URL=<prod> … npx tsx …"), it writes encrypted credential
// material, and — measured 2026-08-27 (V-2069) across all fifteen `apps/*/tests`
// and `packages/*/tests` directories — it was the only file under `apps/server/src`
// whose stem appeared in no test in the repository. 618 of 623 source files
// repo-wide are named by some test; this was one of the five, and the only one
// outside `apps/gui-client`.
//
// Everything security-relevant it does is delegated to code that IS guarded and is
// thoroughly defensive: `livekit-secret-encryption` builds the AAD through a single
// shared builder used by BOTH encrypt and decrypt (so they cannot drift), rejects
// an empty or oversized secret, apiKey and wsUrl (`1..max` bytes on each, so a
// blank `LIVEKIT_API_SECRET=` in the operator's shell throws rather than storing a
// bogus credential), requires nodeId to be a UUID, and lowercases it so a
// case-variant cannot address a different envelope. `fleet-nodes-repo` writes the
// three AAD-bound columns in ONE update, so the tuple can never drift out of sync
// with the ciphertext that authenticates it.
//
// ⛔ ONE property survives all of that and is the script's alone. The AAD binds
// `nodeId`, and the library validates only that it is *a* UUID — never that it is
// the id of the row being written. `fleet_nodes.id` is minted by the DATABASE, so
// the binding is correct only because the script registers FIRST and encrypts with
// the returned `node.id`. Reverse those two steps, or pass a caller-chosen uuid,
// and every check above still passes: the envelope encrypts cleanly, stores
// cleanly, and fails at decrypt time on a production node, long after the operator
// has left. That is what this file pins.
//
// WHAT IT DOES NOT CHECK, stated rather than implied: it reads source text, so it
// verifies the value flows from the register result — not that the row exists or
// that the uuid is the database's. Executing the script needs a real Postgres and
// a real key; that belongs in an integration test, and its absence is why the
// cheap structural pin is worth having.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const SEED_SCRIPT = resolve(SERVER_SRC, 'scripts', 'seed-local-fleet-node.ts');
const SECRET_LIB = resolve(SERVER_SRC, 'lib', 'livekit-secret-encryption.ts');

function seedScript(): string {
  return readFileSync(SEED_SCRIPT, 'utf8');
}

describe('a seeded fleet node binds its AAD to the row it created', () => {
  it('CRITICAL the script was read and still contains both call sites. Every assertion below is an ordering or a substring, and both are satisfied vacuously by a file that no longer calls these functions — a rename would make this suite agree with anything.', () => {
    const src = seedScript();
    expect(src.length, 'seed script source').toBeGreaterThan(2000);
    expect(src, 'registers the node through the repo').toContain('repo.register(');
    expect(src, 'encrypts the LiveKit secret').toContain('encryptLivekitSecret(');
    expect(src, 'stores the credentials through the repo').toContain('setLivekitCredentials(');
  });

  it('CRITICAL the node is registered BEFORE its secret is encrypted, and the AAD binds the id the database minted. fleet_nodes.id is DB-minted, and the encryption library validates only that nodeId is A uuid — never that it is THIS row. So an encrypt-then-register order, or a caller-chosen uuid, passes every downstream check and produces an envelope that decrypts nowhere. Ordering is the whole binding.', () => {
    const src = seedScript();
    const register = src.indexOf('repo.register(');
    const encrypt = src.indexOf('encryptLivekitSecret(');
    expect(register, 'repo.register( is present').toBeGreaterThan(-1);
    expect(encrypt, 'encryptLivekitSecret( is present').toBeGreaterThan(-1);
    expect(
      register,
      'repo.register(...) must appear BEFORE encryptLivekitSecret(...) — the id being bound has to be the one the database returned',
    ).toBeLessThan(encrypt);
    // ⛔ SCOPED to the FIRST binding after each call marker, not by a regex
    // region. `nodeId: node.id` appears TWICE — the encrypt context and the
    // setter — and the setter's call literally CONTAINS the encrypt call as an
    // argument. So both a file-wide `toMatch` AND a lazy `\(...\}\)` region for
    // the setter swallow the other binding and pass while the one they name is
    // corrupted. Both versions were written here and both were caught by
    // mutating each occurrence separately, which is the only reason this arm
    // means anything.
    const bindingAfter = (marker: string): string => {
      const at = src.indexOf(marker);
      if (at < 0) return '';
      const nid = src.indexOf('nodeId:', at);
      return nid < 0 ? '' : src.slice(nid, nid + 40);
    };

    const encryptBinding = bindingAfter('encryptLivekitSecret(');
    expect(encryptBinding, 'the encrypt call has a nodeId binding').not.toBe('');
    expect(encryptBinding, 'the AAD binds the registered row id, not a caller-chosen uuid').toMatch(
      /^nodeId:\s*node\.id\b/,
    );

    const setterBinding = bindingAfter('setLivekitCredentials(');
    expect(setterBinding, 'the setter has a nodeId binding').not.toBe('');
    expect(setterBinding, 'and the row updated is that same registered row').toMatch(
      /^nodeId:\s*node\.id\b/,
    );
  });

  it('CRITICAL LiveKit credentials are all-or-nothing. The script header promises "NO fake dev defaults … so a prod node never gets bogus localhost creds". Two of the three are enough to write a partial, unusable credential tuple, and a prod operator copying a local command line is exactly how that happens.', () => {
    const src = seedScript();
    const guard = /const withLivekit\s*=\s*([\s\S]{0,220}?);/.exec(src);
    expect(guard, 'the all-or-nothing predicate is present').not.toBeNull();
    const body = guard?.[1] ?? '';
    for (const name of ['livekitApiKey', 'livekitSecret', 'livekitWsUrl']) {
      expect(body, `the predicate requires ${name}`).toContain(name);
    }
    expect(
      (body.match(/&&/g) ?? []).length,
      'all three conjoined — an || here would admit a partial tuple',
    ).toBeGreaterThanOrEqual(2);
    expect(body, 'no disjunction in the all-or-nothing guard').not.toContain('||');
  });

  it("CRITICAL this guard's premise still holds — the library validates nodeId SHAPE only. If it ever starts checking that the id belongs to a real row, the ordering above stops being load-bearing and this file should be retired rather than left as a fossil that makes the surface look more examined than it is.", () => {
    const lib = readFileSync(SECRET_LIB, 'utf8');
    expect(lib, 'nodeId is validated as a uuid').toMatch(/UUID_RE\.test\(context\.nodeId\)/);
    expect(
      lib,
      'and nothing in the encryption library reaches the database to confirm the row exists',
    ).not.toMatch(/\bfrom\s+['"][^'"]*\/db\//);
  });
});
