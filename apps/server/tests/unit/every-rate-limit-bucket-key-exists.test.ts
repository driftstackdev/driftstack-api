// Every bucket a route asks for is a bucket the limiter actually defines.
//
// `app.rateLimit(bucketKey)` takes a plain `string` — the decorator signature is
// `(bucketKey: string, cost = 1)` — so `app.rateLimit('sessions:crate')`
// compiles. And an unknown key does not fail: `bucketConfigFor` looks the key up
// in `TIER_RATE_LIMIT_DEFAULTS`, finds nothing, and falls back to the tier's
// `global` bucket.
//
// That fallback is the hazard, and it is worse than a crash would be. A typo
// does not remove rate limiting — it silently WIDENS it. `sessions:create` on
// api_scale is a deliberately tight bucket; `global` on the same tier is 6,000.
// A one-character slip promotes an abuse control to six thousand, with no error,
// no log, and no test failing anywhere. The endpoint keeps returning 200s, which
// is exactly what it did before, so nothing looks wrong until someone abuses it.
//
// All four keys in use are valid today — `global`, `sessions:create`,
// `agent_sessions:message`, `agent_sessions:input_event` — so this is a guard
// against the next edit rather than a fix for a live defect. It converts a
// silent widening into a failing test, which is where that class of mistake
// should be caught: the limiter cannot tell a typo from a deliberate choice, and
// a source scan can.
//
// BOTH SIDES ARE DERIVED. The keys come from the `app.rateLimit('...')` call
// sites in the server source, and the valid set comes from the runtime
// `TIER_RATE_LIMIT_DEFAULTS` object rather than a list restated here — a
// restated list would be a third copy and would drift on its own.
//
// WHAT THIS DOES NOT COVER, stated rather than implied. Only LITERAL keys are
// checked. `middleware/rate-limit.ts` has one pass-through call,
// `app.rateLimit(bucketKey, cost)`, forwarding a variable it was handed; a
// source scan cannot resolve that, and the value it forwards originated at a
// literal call site this file does check. The fallback in `bucketConfigFor` is
// left alone deliberately: it is reachable from `services/rate-limit.ts` with a
// key from an account override, where falling back to `global` is the correct
// behaviour rather than a mistake.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');

/** Bucket keys the limiter defines, read from the runtime table. */
function definedBuckets(): Set<string> {
  const tiers = Object.values(TIER_RATE_LIMIT_DEFAULTS) as Record<string, unknown>[];
  const out = new Set<string>();
  for (const tier of tiers) for (const key of Object.keys(tier)) out.add(key);
  return out;
}

interface CallSite {
  key: string;
  file: string;
  line: number;
}

/** Every literal `app.rateLimit('<key>')` in the server source. */
function literalCallSites(): CallSite[] {
  const out: CallSite[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            return;
          }
          for (const m of line.matchAll(/rateLimit\(\s*'([^']+)'/g)) {
            out.push({ key: m[1]!, file: full.slice(SERVER_SRC.length + 1), line: i + 1 });
          }
        });
    }
  };
  walk(SERVER_SRC);
  return out;
}

describe('every rate-limit bucket key a route asks for exists', () => {
  it('CRITICAL both sides were read and are non-trivial. The comparison reports unknown keys, and an empty scan has no unknown keys — a reader that matched nothing would report every route correctly limited having read no route at all.', () => {
    const defined = definedBuckets();
    const sites = literalCallSites();

    // MEASURED: 4 defined buckets, 4 distinct keys in use.
    expect(defined.size, 'buckets defined in TIER_RATE_LIMIT_DEFAULTS').toBeGreaterThanOrEqual(4);
    expect(sites.length, 'literal app.rateLimit call sites found').toBeGreaterThanOrEqual(4);
    expect(defined.has('global'), 'the fallback bucket itself is defined').toBe(true);
  });

  it('CRITICAL no route asks for a bucket the limiter does not define. An unknown key does NOT fail — bucketConfigFor falls back to the tier global bucket — so a typo silently promotes a tight limit to the widest one, with no error and no log. sessions:create on api_scale is deliberately tight; global on the same tier is 6,000.', () => {
    const defined = definedBuckets();
    const unknown = literalCallSites()
      .filter((s) => !defined.has(s.key))
      .map((s) => `${s.file}:${String(s.line)} asks for '${s.key}'`);
    expect(
      unknown.sort(),
      'rate-limit bucket key(s) with no definition — these silently fall back to global:',
    ).toEqual([]);
  });

  it('CRITICAL the fallback that makes this necessary is still there. If bucketConfigFor ever started throwing on an unknown key, the language would be doing this job and this file would be redundant — worth knowing rather than keeping a guard for a hazard that no longer exists.', () => {
    const src = readFileSync(resolve(SERVER_SRC, 'services', 'rate-limit.ts'), 'utf8');
    expect(src, 'the lookup still falls back rather than rejecting').toMatch(
      /const fallback = tierConfig\.global;/,
    );
    const decorator = readFileSync(resolve(SERVER_SRC, 'middleware', 'rate-limit.ts'), 'utf8');
    expect(decorator, 'and the decorator still accepts an untyped string').toMatch(
      /'rateLimit',\s*\(bucketKey: string/,
    );
  });
});
