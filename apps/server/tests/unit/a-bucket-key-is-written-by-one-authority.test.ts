// Two writers sharing one rate-limit key MUST agree on its capacity.
//
// That sentence is not an aspiration — it is the conclusion of a real,
// destructive incident, recorded in `middleware/rate-limit.ts`. The store key is
// `rl:<accountId>:<bucketKey>` with no tier in it, and the token-bucket script
// persists `math.min(capacity, …)`, so a writer arriving with a LOWER capacity
// permanently truncates the other's bucket. A control key charging a
// conservative `free` floor collapsed a paying `api_scale` owner's 6,000-token
// bucket to about 59, for as long as the desktop Simulator kept polling. The
// middleware's note ends with the invariant, and the fix routed the control key
// through the same live owner authority the effective-owner path already used.
//
// The fix closed the instance. Nothing closed the CLASS: a new call site that
// consumes a token bucket with its own capacity, on a key that collides with an
// existing namespace, reproduces the incident exactly and no test would notice.
// This file is that check.
//
// ── What it asserts, and why each half is needed ───────────────────────────
//
//   1. The two key NAMESPACES are disjoint. IP/internal writers build
//      `<prefix>:<ip|hash>`; account writers pass a bucketKey to
//      `app.rateLimit(...)` and the middleware prefixes it with the account id.
//      A prefix equal to an account bucketKey is the collision that matters,
//      because the two sides derive capacity from different authorities.
//
//   2. Token-bucket consume sites live only in acknowledged modules. Namespace
//      disjointness is a property of the literals present TODAY; this is what
//      makes a NEW writer announce itself, the way V-1048 puts a route that can
//      never succeed on a list somebody had to look at.
//
// ⚠️ The detector keys on the SHAPE of a token-bucket consume — a `.consume(`
// whose argument object carries a `capacity:` — and not on a receiver name.
// `services/auth-flows.ts` calls `this.mfaChallenges.consume(challengeKey)` on a
// different store entirely; a receiver-name detector would either miss a renamed
// rate-limit store or drag that one in.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

/**
 * Modules that may consume a token bucket directly. Each is a deliberate
 * authority over its own key namespace, not a convenience:
 *
 *   services/rate-limit.ts        the shared account-bucket helper every
 *                                 `app.rateLimit(bucketKey)` call goes through
 *   middleware/ip-rate-limit.ts   pre-auth IP gating, `<prefix>:<ip>`
 *   routes/internal-atlas-priority.ts
 *                                 per-token internal gate,
 *                                 `atlas_priority_token:<sha256-prefix>`
 *
 * Adding an entry is a claim that the new site's keys cannot collide with an
 * existing namespace AND that nothing else writes its keys with a different
 * capacity. That is the judgement this list exists to force.
 */
const BUCKET_WRITERS = new Set([
  'services/rate-limit.ts',
  'middleware/ip-rate-limit.ts',
  'routes/internal-atlas-priority.ts',
]);

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'migrations') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Non-comment source, so a note quoting a key literal is not a key literal. */
function codeOf(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join('\n');
}

interface Scan {
  file: string;
  ipPrefixes: string[];
  accountBucketKeys: string[];
  bucketConsumes: number;
}

function scan(): Scan[] {
  return tsFiles(SERVER_SRC).map((full) => {
    const code = codeOf(readFileSync(full, 'utf8'));
    return {
      file: full.slice(SERVER_SRC.length + 1),
      ipPrefixes: [
        ...[...code.matchAll(/bucketPrefix: '([a-z0-9_-]+)'/g)].map((m) => m[1] as string),
        ...[...code.matchAll(/key: `([a-z0-9_]+):/g)].map((m) => m[1] as string),
      ],
      accountBucketKeys: [...code.matchAll(/rateLimit\('([a-z0-9_:.-]+)'\)/g)].map(
        (m) => m[1] as string,
      ),
      // A token-bucket consume. ⛔ NOT `.consume({…capacity:…})` — `ip-rate-limit.ts`
      // builds `consumeArgs` as a variable and passes it, so an inline-object
      // pattern scored it ZERO and the rot arm below caught that on the first run.
      // The shape is: this module calls consume AND declares a capacity.
      // Validated both ways — it finds the three real writers, and excludes
      // `services/auth-flows.ts`, which calls `.consume(` three times on the MFA
      // challenge store and never mentions a capacity.
      bucketConsumes: /capacity:/.test(code)
        ? [...code.matchAll(/\.consume(?:SlidingWindow)?\(/g)].length
        : 0,
    };
  });
}

describe('a bucket key is written by one authority', () => {
  const scans = scan();

  it('CRITICAL the scan read the server source, so an empty result cannot pass for agreement', () => {
    expect(scans.length, 'server source files walked').toBeGreaterThanOrEqual(300);
    expect(
      scans.reduce((n, s) => n + s.ipPrefixes.length, 0),
      'IP/internal key prefixes discovered',
    ).toBeGreaterThanOrEqual(10);
    expect(
      scans.reduce((n, s) => n + s.accountBucketKeys.length, 0),
      'account bucket keys discovered',
    ).toBeGreaterThanOrEqual(50);
  });

  it('CRITICAL no IP/internal key prefix equals an account bucket key. A collision puts two writers on one key, and they derive capacity from different authorities — which is the incident the middleware note records.', () => {
    const prefixes = new Set(scans.flatMap((s) => s.ipPrefixes));
    const bucketKeys = new Set(scans.flatMap((s) => s.accountBucketKeys));
    const collisions = [...prefixes].filter((p) => bucketKeys.has(p)).sort();
    expect(
      collisions,
      'a key prefix that is also an account bucket key — the two sides size the bucket differently, and the smaller one wins permanently',
    ).toEqual([]);
  });

  it('CRITICAL a token-bucket consume lives only in an acknowledged writer. Namespace disjointness describes the literals present today; this is what makes a NEW writer announce itself instead of arriving silently.', () => {
    const unlisted = scans
      .filter((s) => s.bucketConsumes > 0 && !BUCKET_WRITERS.has(s.file))
      .map((s) => `${s.file} (${String(s.bucketConsumes)})`)
      .sort();
    expect(
      unlisted,
      'a module consumes a token bucket without being an acknowledged writer — add it to BUCKET_WRITERS only after checking its keys cannot collide with an existing namespace',
    ).toEqual([]);
  });

  it('the acknowledged-writer list cannot rot — every entry must still exist and still consume a bucket', () => {
    for (const name of BUCKET_WRITERS) {
      const found = scans.find((s) => s.file === name);
      expect(found, `${name} is listed as a bucket writer but no longer exists`).toBeDefined();
      expect(
        found?.bucketConsumes ?? 0,
        `${name} no longer consumes a token bucket — drop it from BUCKET_WRITERS`,
      ).toBeGreaterThan(0);
    }
  });
});
