// Rate-limit bucket DISCLOSURE invariant (A2, 2026-07-31).
//
// `rate-limit-bucket-cross-source-invariant` pins the bucket-key ROSTER across
// schemas. It does not pin which ROUTES consume each bucket, and that gap let a
// real falsehood live on two customer pages: `api/account-rate-limits.md`
// claimed `sessions:create` was consumed by "`POST /v1/sessions` only" when
// `POST /v1/profiles/:id/launch` draws on it too (both carry
// `app.rateLimit('sessions:create')` in routes/sessions.ts), and
// `guides/concurrency.md` carried a retired dual-bucket fiction. A3 found both
// while correcting the reference page; neither guard caught them.
//
// A customer sizing an integration against "only POST /v1/sessions" budgets the
// wrong call and is throttled by a bucket the docs told them they were not
// touching. So: for every DEDICATED bucket, every route that actually enforces
// it must be named on the pages that describe it.
//
// `global` is excluded by design — it is the default bucket for "every
// authenticated /v1/* without a dedicated bucket", so enumerating its consumers
// would be enumerating the whole API.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** Pages that describe the bucket→route mapping to customers. */
const DISCLOSURE_PAGES = [
  'apps/docs/src/pages/reference/rate-limits.md',
  'apps/docs/src/pages/api/account-rate-limits.md',
];

/**
 * `global` is the catch-all; enumerating it would enumerate the API.
 *
 * DERIVED from the canonical enum rather than hand-listed. A hardcoded roster
 * silently fails to cover a bucket added later — the same self-grading hole
 * that let a deleted staff-scope gate pass its own generated table. The census
 * assertion below pins the count so a NEW bucket is a deliberate decision.
 */
const CANONICAL_BUCKET_ENUM = resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts');

/**
 * Every `.ts` under `apps/server/src`, not just `src/routes`.
 *
 * Registration is not confined to that directory — `/v1/whoami` lives in
 * `lib/app.ts` — and a scan limited to `routes/` silently exempts anything
 * registered elsewhere. That is a FALSE NEGATIVE in a disclosure guard: the
 * route would enforce a gate nobody checked. No such route exists today (the
 * one outside `routes/` carries no scope and the `global` bucket), so this
 * closes a latent hole rather than a live one.
 */
function serverSourceFiles(): string[] {
  const out: string[] = [];
  const stack = [resolve(REPO_ROOT, 'apps/server/src')];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  }
  return out;
}

function dedicatedBuckets(): string[] {
  const src = readFileSync(CANONICAL_BUCKET_ENUM, 'utf8');
  const block = /bucket_key: z\.enum\(\[([\s\S]*?)\]\)/.exec(src);
  if (block === null) throw new Error('canonical bucket_key enum not found');
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).filter((k) => k !== 'global');
}

const DEDICATED_BUCKETS = dedicatedBuckets();

/**
 * Buckets whose consumers are deliberately not enumerated on customer pages.
 * `agent_sessions:input_event` is the high-frequency manual-control stream and
 * is internal-only on the admin-write surface; it is described by purpose
 * rather than by a route list.
 */
const PURPOSE_DESCRIBED_ONLY = new Set<string>([
  // Emptied 2026-08-01. The shrink assertion below found this exemption was
  // already stale: both disclosure pages DO name
  // `POST /v1/agent-sessions/:id/input-event` right beside the bucket key, so
  // the bucket was never "described by purpose rather than by a route list".
  // It is now checked like every other dedicated bucket.
]);

/**
 * The dedicated-bucket count, pinned. Derivation above means a new bucket is
 * covered automatically; this makes it VISIBLE rather than silently absorbed,
 * so adding one is a decision about customer disclosure, not a side effect.
 */
const EXPECTED_DEDICATED_BUCKET_COUNT = 3;

function enforcedConsumers(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of serverSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const regs = [
      ...src.matchAll(/\bapp\.(get|post|put|patch|delete)\b[^(]*\(\s*['"`](\/v1\/[^'"`]+)['"`]/g),
    ];
    regs.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < regs.length ? regs[i + 1]!.index : Math.min(src.length, start + 2500);
      const window = src.slice(start, end);
      for (const b of window.matchAll(/rateLimit\(\s*'([^']+)'/g)) {
        const key = b[1]!;
        const list = out.get(key) ?? [];
        list.push(`${m[1]!.toUpperCase()} ${m[2]!}`);
        out.set(key, list);
      }
    });
  }
  return out;
}

function disclosurePages(): { path: string; text: string }[] {
  const resolved = DISCLOSURE_PAGES.filter((p) => existsSync(resolve(REPO_ROOT, p)));
  // V-1289 — the missing-page check lives HERE, not in one arm. Filtering the declared pages down
  // by existence means a page that is renamed or deleted leaves the population smaller and every
  // arm still green: it checks fewer pages and says nothing about the one that vanished. Three arms
  // call this and only one asserted the full count, so two of them were reading an absence as a
  // clean result. Asserting inside the helper gives every caller the check by construction.
  expect(
    resolved,
    'a declared rate-limit disclosure page no longer resolves — restore it, or remove it from ' +
      'DISCLOSURE_PAGES deliberately',
  ).toEqual([...DISCLOSURE_PAGES]);
  return resolved.map((p) => ({
    path: p,
    text: readFileSync(resolve(REPO_ROOT, p), 'utf8'),
  }));
}

/**
 * The text following each mention of a bucket key on one page — the mention's
 * own line from the key onward, plus the next few lines, which covers a wrapped
 * prose bullet and the rest of a markdown table row alike.
 *
 * Two properties matter and both are load-bearing:
 *  - per PAGE, not pooled. A customer reads one page; a correct sentence on the
 *    other page must not launder a false one here.
 *  - AFTER the mention, not around it. "a `POST /v1/sessions` consumes only from
 *    `sessions:create`" is a true statement about which bucket the call drains;
 *    "`sessions:create` — `POST /v1/sessions` only" is a false statement about
 *    which routes drain the bucket. Direction is the whole difference.
 */
function mentionTails(text: string, bucket: string): string[] {
  const lines = text.split('\n');
  const tails: string[] = [];
  lines.forEach((line, i) => {
    const at = line.indexOf(bucket);
    if (at === -1) return;
    tails.push(
      [line.slice(at + bucket.length), ...lines.slice(i + 1, i + 4)].join('\n').slice(0, 400),
    );
  });
  return tails;
}

describe('customer pages name every route that consumes a dedicated rate-limit bucket', () => {
  const enforced = enforcedConsumers();

  it('CRITICAL the dedicated-bucket roster is DERIVED from the canonical enum and its size is pinned. The previous hardcoded list would have silently excluded any bucket added later — the same self-grading hole that let a deleted staff gate pass its own generated table.', () => {
    expect(DEDICATED_BUCKETS.length, 'dedicated buckets derived from the canonical enum').toBe(
      EXPECTED_DEDICATED_BUCKET_COUNT,
    );
    expect(DEDICATED_BUCKETS, 'a known bucket must survive derivation').toContain(
      'sessions:create',
    );
    expect(DEDICATED_BUCKETS, 'global is the catch-all and must be excluded').not.toContain(
      'global',
    );
  });

  it('CRITICAL the purpose-described exemption may only SHRINK — if a bucket gains a route list on a customer page, it must leave the list. An allowlist that only grows is a mute button with extra steps.', () => {
    const pages = disclosurePages();
    const stillExempt: string[] = [];
    for (const bucket of PURPOSE_DESCRIBED_ONLY) {
      // Live on the roster at all?
      expect(DEDICATED_BUCKETS, `${bucket} is exempted but is not a dedicated bucket`).toContain(
        bucket,
      );
      const consumers = enforced.get(bucket) ?? [];
      const named = pages.some((page) =>
        consumers.some((route) => mentionTails(page.text, bucket).join('\n').includes(route)),
      );
      if (named) stillExempt.push(bucket);
    }
    expect(
      stillExempt.sort(),
      'these buckets now name their routes on a customer page — remove them from PURPOSE_DESCRIBED_ONLY so they are checked:',
    ).toEqual([]);
  });

  it('the parse found real consumers for each dedicated bucket (a broken parse would make this vacuous)', () => {
    for (const bucket of DEDICATED_BUCKETS) {
      expect(enforced.get(bucket) ?? [], `no route enforces ${bucket}`).not.toEqual([]);
    }
  });

  it('CRITICAL every page that describes a dedicated bucket names EVERY route that consumes it. A customer sizing against an incomplete list budgets the wrong call and is then throttled by a bucket the docs said they were not touching — exactly the `sessions:create` "POST /v1/sessions only" falsehood that shipped.', () => {
    const pages = disclosurePages();
    expect(pages.length, 'no disclosure page resolved').toBe(DISCLOSURE_PAGES.length);

    const undisclosed: string[] = [];
    for (const bucket of DEDICATED_BUCKETS) {
      if (PURPOSE_DESCRIBED_ONLY.has(bucket)) continue;
      const describing = pages.filter((p) => p.text.includes(bucket));
      expect(describing.length, `no page describes ${bucket}`).toBeGreaterThan(0);
      for (const page of describing) {
        const described = mentionTails(page.text, bucket).join('\n');
        // Method-qualified on purpose. `GET /v1/sessions` drawing on
        // `sessions:create` would be just as undisclosed as an unnamed path,
        // even though the page names `POST /v1/sessions`.
        for (const route of enforced.get(bucket) ?? []) {
          if (!described.includes(route)) undisclosed.push(`${page.path}: ${bucket} ← ${route}`);
        }
      }
    }

    expect(
      [...new Set(undisclosed)].sort(),
      'Route(s) consume a dedicated bucket without being named where the page describes that bucket:',
    ).toEqual([]);
  });

  it('CRITICAL no page narrows a multi-consumer bucket to "only" one route. "only" is what made the previous claim false rather than merely incomplete — an incomplete list under-informs, a closed one misinforms.', () => {
    const falseClaims: string[] = [];
    for (const bucket of DEDICATED_BUCKETS) {
      const consumers = enforced.get(bucket) ?? [];
      if (consumers.length <= 1) continue;
      for (const page of disclosurePages()) {
        for (const tail of mentionTails(page.text, bucket)) {
          if (!/\bonly\b/.test(tail)) continue;
          const named = consumers.filter((r) => tail.includes(r));
          if (named.length < consumers.length) {
            falseClaims.push(
              `${page.path}: ${bucket} has ${consumers.length} consumers (${consumers.join(', ')}) but a passage says "only" while naming ${named.length}`,
            );
          }
        }
      }
    }
    expect([...new Set(falseClaims)].sort(), 'Closed-list claim that is not true:').toEqual([]);
  });
});
