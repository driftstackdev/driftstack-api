// The AES-GCM wire parameters live in one module, and only one.
//
// Ten encryption modules each declared `AES_256_KEY_BYTES = 32`,
// `GCM_IV_BYTES = 12` and `GCM_TAG_BYTES = 16` locally, with identical values,
// and five content-parity tests pinned their own file's copy as source text.
// A coverage grep found every copy guarded. Nothing required the ten to AGREE.
//
// The failure that allows: change one module's IV to 16 bytes "for hardening",
// update that file's pin, and the suite stays green while that module writes
// envelopes the other nine cannot parse. GCM's security argument is built
// around the 96-bit IV it would no longer be using, and the mismatch surfaces
// as undecryptable stored secrets rather than as a test failure.
//
// These are not tunables — they are the shape of the algorithm. AES-256 takes a
// 256-bit key; GCM is specified for a 96-bit IV; its tag is 128 bits. A module
// disagreeing is a bug in that module, never local policy. So the fix is one
// imported module rather than ten agreeing declarations, and this keeps the
// copies from coming back.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AES_256_KEY_BYTES,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
} from '../../src/lib/aes-gcm-parameters.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const HOME = 'apps/server/src/lib/aes-gcm-parameters.ts';

const SOURCES = execFileSync('git', ['ls-files', 'apps/server/src', 'packages'], {
  cwd: REPO,
  encoding: 'utf-8',
})
  .split('\n')
  .filter((f) => f.endsWith('.ts') && !f.includes('/tests/'))
  .map((file) => ({ file, body: readFileSync(resolve(REPO, file), 'utf-8') }));

const PARAMETERS = ['AES_256_KEY_BYTES', 'GCM_IV_BYTES', 'GCM_TAG_BYTES'] as const;

describe('AES-GCM parameters are never redeclared', () => {
  it('CRITICAL the scan reads real sources and can see the one legitimate declaration', () => {
    expect(
      SOURCES.length,
      'no sources scanned — this would pass over an empty set',
    ).toBeGreaterThan(200);
    const home = SOURCES.find(({ file }) => file === HOME);
    expect(
      home,
      `${HOME} not found — the parameters have moved and this guard needs updating`,
    ).toBeDefined();
    for (const name of PARAMETERS)
      expect(home!.body, `${HOME} no longer declares ${name}`).toMatch(
        new RegExp(`export const ${name} = \\d+;`),
      );
  });

  it('CRITICAL no module outside the home declares them', () => {
    const redeclared: string[] = [];
    for (const { file, body } of SOURCES) {
      if (file === HOME) continue;
      for (const name of PARAMETERS)
        if (new RegExp(`const ${name}\\s*=`).test(body))
          redeclared.push(`${file}: declares ${name} instead of importing it`);
    }
    expect(
      redeclared.sort(),
      'an encryption module holds its own copy of an AES-GCM parameter. Ten of them used to, each ' +
        'with its own passing pin, and nothing made them agree',
    ).toEqual([]);
  });

  it('CRITICAL every consumer of the parameters imports them from the home module', () => {
    const users = SOURCES.filter(
      ({ file, body }) => file !== HOME && PARAMETERS.some((n) => body.includes(n)),
    );
    expect(
      users.length,
      'no consumer found — the parameters would be dead code',
    ).toBeGreaterThanOrEqual(8);
    const missing = users
      .filter(({ body }) => !body.includes("aes-gcm-parameters.js'"))
      .map(({ file }) => file);
    expect(
      missing.sort(),
      'this module uses an AES-GCM parameter without importing it from the home module',
    ).toEqual([]);
  });

  it('CRITICAL the values are the algorithm’s, not something else', () => {
    // A guard that only checks "one declaration" would happily accept one WRONG
    // declaration. These three numbers are fixed by AES-256-GCM itself.
    expect(AES_256_KEY_BYTES, 'AES-256 takes a 256-bit key').toBe(32);
    expect(GCM_IV_BYTES, 'GCM is specified for a 96-bit IV').toBe(12);
    expect(GCM_TAG_BYTES, 'a full-strength GCM tag is 128 bits').toBe(16);
  });
});
