// Every environment variable the server reads is discoverable, or is on a
// shrinking baseline.
//
// `config.ts` reads 73 env vars. An operator can find 62 of them in
// `.env.example` or the runbooks. The other 11 exist only in the source: you
// cannot tune what you cannot discover, and you cannot audit a deployment
// against knobs you do not know about.
//
// None of the 11 is required — every one has a working fallback, so this is an
// operability gap rather than a deploy-breaking one, and that is why this file
// does NOT demand they all be documented today. Forcing a docs sprint over
// optional tuning knobs would be busywork, and a guard that demands busywork
// gets muted.
//
// The seven operator-visible ones were paid down when this landed: the Stripe
// and NowPayments redirect URLs (customer-visible immediately after payment),
// the global IP rate limit, and the slow-query threshold. The shrink assertion
// below is what forced that — it failed until they left the list.
//
// Instead the baseline is pinned and may only SHRINK. A new undocumented env
// var fails; documenting an existing one fails too, with a message saying to
// remove it from the list. The second direction matters: without it the
// baseline rots into a permanent excuse.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CONFIG = resolve(REPO_ROOT, 'apps/server/src/lib/config.ts');

/** Where an operator would look for a knob. */
const OPERATOR_SOURCES = ['.env.example', 'README.md', 'docs/runbooks', 'docs/internal'];

/**
 * Env vars readable only from source today. This list may shrink, never grow.
 *
 * Every entry is OPTIONAL with a working fallback — checked when the list was
 * built. If any of these ever becomes required, it belongs in `.env.example`
 * that same day, not on this list.
 */
const UNDOCUMENTED_BASELINE: readonly string[] = [
  'AGENT_RELAY_MAX_ACCOUNT_INFLIGHT',
  'AGENT_TURN_MAX_ACCOUNT_INFLIGHT',
  'AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES',
  'AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_COUNT',
  'BUNDLED_TURN_MAX_CONCURRENCY',
  'DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK',
  'DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY',
  'DRIFTSTACK_ANTHROPIC_MODEL',
  'DRIFTSTACK_DEPLOY_ENV',
  'PLAYWRIGHT_HEADED',
  'STRIPE_API_VERSION',
];

function filesUnder(dir: string): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

function envVarsRead(): string[] {
  const src = readFileSync(CONFIG, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})/g)) names.add(m[1]!);
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) names.add(m[1]!);
  return [...names].sort();
}

function operatorCorpus(): string {
  let corpus = '';
  for (const src of OPERATOR_SOURCES) {
    const full = resolve(REPO_ROOT, src);
    if (!existsSync(full))
      throw new Error(
        `walk root is missing: ${full} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
      );
    if (statSync(full).isFile()) corpus += readFileSync(full, 'utf8');
    else for (const f of filesUnder(full)) corpus += readFileSync(f, 'utf8');
  }
  return corpus;
}

describe('env vars the server reads are discoverable by an operator', () => {
  const read = envVarsRead();
  const corpus = operatorCorpus();

  it('CRITICAL the scan found the env surface and an operator corpus, so the comparisons below are not vacuous', () => {
    expect(read.length, 'env vars read by config.ts').toBeGreaterThan(50);
    expect(corpus.length, 'operator documentation corpus').toBeGreaterThan(50_000);
    expect(read).toContain('DATABASE_URL');
  });

  it('CRITICAL no NEW undocumented env var appears. A knob that exists only in source cannot be tuned, cannot be audited against a running deployment, and will not be found by whoever is on call.', () => {
    const undocumented = read.filter((v) => !corpus.includes(v));
    const added = undocumented.filter((v) => !UNDOCUMENTED_BASELINE.includes(v)).sort();
    expect(added, 'env var(s) read by config.ts but documented nowhere:').toEqual([]);
  });

  it('CRITICAL the baseline may only SHRINK — a documented var must leave the list. Without this the baseline rots into a permanent excuse rather than a debt being paid down.', () => {
    const undocumented = new Set(read.filter((v) => !corpus.includes(v)));
    const nowDocumented = UNDOCUMENTED_BASELINE.filter((v) => !undocumented.has(v)).sort();
    expect(
      nowDocumented,
      'these are documented now — remove them from UNDOCUMENTED_BASELINE:',
    ).toEqual([]);
  });
});
