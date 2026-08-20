// V-1134 — the public R2 bucket holds customer data, and its config comment says it does not.
//
// `lib/config.ts` documents `bucketPublic` as the V-295c2 status-page snapshot bucket
// and states plainly that it "holds operational JSON only (incident snapshots)". The
// rationale in the same comment is a Customer Data boundary: recordings stay on the
// private bucket because they contain Customer Data.
//
// V-352b later put customer-uploaded avatars on that same bucket —
// `r2Public.putObject` at `routes/account-me.ts`, keyed `avatars/<account_id>.<ext>`.
// An avatar is customer-uploaded personal data. So the comment is false, and the
// boundary it describes is not the one the code enforces.
//
// This is NOT the open decision. Whether the bucket should be public-read at all, and
// whether a reaper should collect avatar objects after deletion, is D-2 and needs the
// real Cloudflare ACL, which cannot be read from this repo. What IS settled is that the
// source must not describe the bucket as carrying operational JSON only while an
// avatar-upload path writes to it. A decision taken against a false description of
// where customer data lives is a decision taken on the wrong facts.
//
// The guard derives the consumer set instead of pinning a number, because the failure
// this prevents is a THIRD consumer being added quietly. Two derivations, unioned:
// files that reference the public client directly, and classes bootstrap constructs
// with it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/**
 * Files that plumb the public client around without deciding what goes in it.
 * Excluded so the roster names actual consumers rather than the wiring.
 */
const WIRING = new Set(['lib/r2.ts', 'lib/app.ts', 'lib/config.ts', 'lib/bootstrap.ts']);

/**
 * What the public bucket carries today, one entry per consumer. Adding a consumer
 * means adding a line here AND making the config comment honest about it.
 */
const DECLARED: Readonly<Record<string, string>> = {
  'routes/account-me.ts': 'customer-uploaded avatars, keyed avatars/<account_id>.<ext> (V-352b)',
  'services/status-snapshot.ts': 'operational incident JSON for the status page (V-295c2)',
};

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('V-1134 the public bucket holds what config says it holds', () => {
  it('CRITICAL every consumer of the public R2 bucket is declared. Derived from source, not counted: the failure this prevents is a third consumer being added quietly, and a roster that is its own population cannot report one it never listed.', () => {
    // Walked inside the arm, never at module scope — a throw there collapses the whole
    // file into "no tests" rather than a failure.
    const files = walk(SRC, []);
    expect(files.length, 'no source files walked — the src layout moved').toBeGreaterThan(50);

    const direct = files
      .map((f) => relative(SRC, f))
      .filter(
        (rel) => !WIRING.has(rel) && readFileSync(resolve(SRC, rel), 'utf8').includes('r2Public'),
      );

    // Second derivation: classes bootstrap hands the public client to. Their own file
    // never names `r2Public`, so the direct scan alone would miss them entirely.
    const boot = read('apps/server/src/lib/bootstrap.ts');
    const constructed = [...boot.matchAll(/new\s+([A-Z][A-Za-z]*)\s*\([^)]*\br2Public\b/g)].map(
      (m) => m[1] ?? '',
    );
    expect(
      constructed.length,
      'no class is constructed with r2Public — the wiring moved',
    ).toBeGreaterThan(0);

    const viaBootstrap = constructed.map((cls) => {
      const hit = files.find((f) =>
        new RegExp(`^export class ${cls}\\b`, 'm').test(readFileSync(f, 'utf8')),
      );
      return hit === undefined ? `UNRESOLVED:${cls}` : relative(SRC, hit);
    });

    const consumers = [...new Set([...direct, ...viaBootstrap])].sort();
    expect(consumers, 'consumers of the public bucket, vs the declared roster').toEqual(
      Object.keys(DECLARED).sort(),
    );
  });

  it('CRITICAL the config comment does not describe the public bucket as operational-JSON-only. Customer avatars are written to it, so that sentence is false; a reader trusting it would conclude no customer data can reach a public-read bucket. This is the sentinel for the retired wording.', () => {
    const cfg = read('apps/server/src/lib/config.ts');
    expect(cfg, 'the retired claim is back in config.ts').not.toMatch(
      /holds operational JSON only/,
    );
  });

  it('CRITICAL the config comment names the customer data it actually carries. Deleting the avatar sentence would leave the boundary undocumented rather than wrong, which reads the same to anyone deciding D-2.', () => {
    const cfg = read('apps/server/src/lib/config.ts');
    const block = cfg.slice(0, cfg.indexOf('bucketPublic:'));
    expect(block, 'the bucketPublic comment no longer mentions avatars').toMatch(/avatar/i);
  });

  it('CRITICAL avatars are still keyed by account id on the public bucket, which is what makes the comment load-bearing. If this moves to the private bucket the finding is resolved at the source and the arms above should be revisited, not edited around.', () => {
    expect(read('apps/server/src/lib/r2.ts'), 'the avatar key shape moved').toMatch(
      /avatars\/\$\{accountId\}\.\$\{ext\}/,
    );
    expect(
      read('apps/server/src/routes/account-me.ts'),
      'avatars no longer written to r2Public',
    ).toMatch(/r2Public\.putObject/);
  });
});
