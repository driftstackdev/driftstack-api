// A lookup with no fallback must cover its whole vocabulary.
//
// The frontends render enum values through const maps — STATUS_BADGE,
// SEVERITY_BADGE, CRYPTO_BADGE, SCOPE_LABEL. Whether such a map has to be
// COMPLETE depends entirely on how it is read, and that turns out to be the
// whole rule:
//
//   SCOPE_LABEL[s] || s                covers 6 of 19 scopes, and is correct.
//                                      It abbreviates driftstack_internal_admin
//                                      to internal_admin; a granular scope falls
//                                      through as `read:sessions`, already
//                                      readable. Completeness is not wanted.
//   SEVERITY_BADGE[inc.severity]       goes straight into a class list. A miss
//                                      is `undefined` in the markup, on the page
//                                      someone opened during an incident.
//
// So the property is not "every map is complete" — that would be wrong, and I
// nearly reported SCOPE_LABEL as a defect on the way here. It is: a map read
// WITHOUT a fallback must be complete. Maps that always read with `||` are free
// to be partial, and several deliberately are.
//
// Measured across status-site, customer-dashboard and admin-panel: nine
// no-fallback lookups, all complete today. Eight are the incident maps, which
// incident-enum-cross-source-invariant covers per-vocabulary. The ninth is
// account-detail's STATUS_BADGE on AccountStatus, which nothing covered — a
// fourth account status would render undefined there.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as ApiTypes from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const APP_ROOTS = [
  'apps/status-site/src',
  'apps/customer-dashboard/src',
  'apps/admin-panel/src',
] as const;

/** Every string-enum vocabulary the API declares, read from the schemas. */
function vocabularies(): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [name, value] of Object.entries(ApiTypes)) {
    const options = (value as { options?: unknown })?.options;
    if (
      Array.isArray(options) &&
      options.length >= 3 &&
      options.every((o) => typeof o === 'string')
    ) {
      out.set(name, options);
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(astro|ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

interface Lookup {
  readonly file: string;
  readonly map: string;
  readonly vocab: string;
  readonly missing: readonly string[];
}

/**
 * Maps whose keys are all members of one vocabulary, read at least once with no
 * `||` fallback.
 */
function unguardedLookups(): Lookup[] {
  const vocabs = vocabularies();
  const found: Lookup[] = [];
  for (const root of APP_ROOTS) {
    for (const file of walk(resolve(REPO_ROOT, root))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/const ([A-Z][A-Z0-9_]+)\s*=\s*\{([\s\S]*?)\n\s*\};/g)) {
        const name = m[1] ?? '';
        const keys = new Set(
          [...(m[2] ?? '').matchAll(/^\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*:/gm)].map(
            (k) => k[1] ?? '',
          ),
        );
        if (keys.size < 2) continue;
        // Which vocabulary is this map keyed on? The smallest one that contains
        // every key, so a 3-key map is not matched against a 19-value enum it
        // happens to be a subset of.
        const candidates = [...vocabs.entries()]
          .filter(([, vals]) => [...keys].every((k) => vals.includes(k)))
          .sort((a, b) => a[1].length - b[1].length);
        const match = candidates[0];
        if (match === undefined) continue;
        const readsWithoutFallback = [
          ...src.matchAll(new RegExp(`${name}\\[[^\\]]+\\]\\s*(\\|\\|)?`, 'g')),
        ].some((r) => r[1] === undefined);
        if (!readsWithoutFallback) continue;
        found.push({
          file: file.slice(REPO_ROOT.length + 1),
          map: name,
          vocab: match[0],
          missing: match[1].filter((v) => !keys.has(v)),
        });
      }
    }
  }
  return found;
}

describe('enum-keyed lookups without a fallback cover their vocabulary', () => {
  const lookups = unguardedLookups();

  it('CRITICAL the scan found no-fallback lookups, and does not flag the ones with a fallback', () => {
    // Both directions. A scan finding nothing asserts nothing; a scan that
    // ignored `||` would flag SCOPE_LABEL, which is partial on purpose.
    expect(
      lookups.length,
      'no no-fallback enum lookups found — the scan is broken',
    ).toBeGreaterThan(5);
    expect(
      lookups.map((l) => `${l.file}:${l.map}`),
      'SCOPE_LABEL is read as `SCOPE_LABEL[s] || s` and is deliberately partial — flagging it ' +
        'means the fallback detection stopped working',
    ).not.toContain('apps/customer-dashboard/src/pages/api-keys.astro:SCOPE_LABEL');
    expect(
      lookups.some((l) => l.file.endsWith('shells/account-detail.astro')),
      'account-detail STATUS_BADGE reads with no fallback and should be in scope',
    ).toBe(true);
  });

  it('CRITICAL every no-fallback lookup covers its whole vocabulary', () => {
    const gaps = lookups
      .filter((l) => l.missing.length > 0)
      .map((l) => `${l.file}: ${l.map} (${l.vocab}) missing ${l.missing.join(', ')}`)
      .sort();
    expect(
      gaps,
      'this map is read without a `||` fallback, so a value it lacks renders as undefined in the ' +
        'markup. Either add the missing entries, or give the lookup a fallback and decide what an ' +
        'unknown value should look like',
    ).toEqual([]);
  });
});
