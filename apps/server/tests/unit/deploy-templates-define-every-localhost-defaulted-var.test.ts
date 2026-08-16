// Every var that `loadConfig` silently defaults to a LOCALHOST endpoint must be
// defined in the deploy templates an operator actually ships.
//
// `infra/bootstrap/deploy-api.sh` tells the operator to copy
// `env-templates/$ROLE.env.template` to `$ROLE.env` (line 52), then scp's that
// file straight to `/opt/driftstack/api/.env` (line 95). So a key missing from
// the template is a key missing from production.
//
// That is not hypothetical. `REDIS_URL` was absent from BOTH templates while
// `config.ts` read `env.REDIS_URL ?? 'redis://localhost:6379'`, so a deploy
// built from the template ran production Redis against localhost — silently,
// because a default is not an error. Redis backs rate limiting, the MFA
// challenge store (single-use), the pair-mode takeover lock, the CLI authorize
// store and the auth cache, so the failure mode is either total unavailability
// or, with a stray local Redis, security state on an ephemeral unreplicated
// store. The whole suite was green with that defect live.
//
// The templates said Redis was configured — they carried
// `UPSTASH_REDIS_REST_URL` + `_TOKEN` and a comment claiming "the server's Redis
// client wraps @upstash/redis around the REST URL + token". `@upstash/redis` is
// not a dependency of this repository; `bootstrap.ts` builds `new Redis(
// config.redisUrl)` with ioredis. The comment described an architecture that no
// longer existed, and a content-parity pin had frozen the two dead keys in
// place, which is what made the omission look like configuration.
//
// The pairing is DERIVED on both sides — the var set is read out of `config.ts`
// at runtime and the template set off disk — so a NEW localhost-defaulted var,
// or a NEW template, is covered without editing this file.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const CONFIG_TS = resolve(HERE, '..', '..', 'src', 'lib', 'config.ts');
const TEMPLATE_DIR = resolve(REPO, 'infra', 'env-templates');

/**
 * `env.FOO ?? '…localhost…'` — a read whose fallback is a developer endpoint.
 *
 * `\s*` spans newlines deliberately: prettier wraps these across three lines
 * once the default is long enough, and a single-line-only pattern would quietly
 * stop seeing them.
 */
const LOCALHOST_DEFAULT =
  /env\.([A-Z][A-Z0-9_]*)\s*\?\?\s*'([^']*(?:localhost|127\.0\.0\.1)[^']*)'/g;

function localhostDefaultedVars(): Array<{ name: string; fallback: string }> {
  const source = readFileSync(CONFIG_TS, 'utf-8');
  const found = new Map<string, string>();
  for (const m of source.matchAll(LOCALHOST_DEFAULT)) found.set(m[1]!, m[2]!);
  return [...found]
    .map(([name, fallback]) => ({ name, fallback }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function templates(): string[] {
  return readdirSync(TEMPLATE_DIR)
    .filter((f) => f.endsWith('.env.template'))
    .map((f) => join(TEMPLATE_DIR, f))
    .sort();
}

describe('deploy templates define every localhost-defaulted var', () => {
  it('CRITICAL both sides were read and are non-trivial, so an absence is measured against a real set', () => {
    expect(existsSync(CONFIG_TS), 'config.ts not found — the scan is broken').toBe(true);
    expect(
      localhostDefaultedVars().length,
      'no localhost-defaulted var found — either the idiom changed or the pattern is broken',
    ).toBeGreaterThan(0);
    expect(
      templates().length,
      'no deploy templates found — the scan is broken',
    ).toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL a var that falls back to localhost is defined in every deploy template', () => {
    const vars = localhostDefaultedVars();
    const missing: string[] = [];

    for (const file of templates()) {
      const body = readFileSync(file, 'utf-8');
      const name = file.slice(file.lastIndexOf('/') + 1);
      for (const v of vars) {
        if (!new RegExp(`^${v.name}=`, 'm').test(body)) {
          missing.push(`${name} is missing ${v.name} (deploys would use ${v.fallback})`);
        }
      }
    }

    expect(
      missing.sort(),
      'deploy-api.sh ships these templates verbatim as /opt/driftstack/api/.env, so each missing key ' +
        'means production silently runs against a localhost endpoint rather than failing loudly',
    ).toEqual([]);
  });
});
