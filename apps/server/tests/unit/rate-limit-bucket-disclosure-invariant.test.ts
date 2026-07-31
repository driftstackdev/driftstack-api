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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

/** Pages that describe the bucket→route mapping to customers. */
const DISCLOSURE_PAGES = [
  'apps/docs/src/pages/reference/rate-limits.md',
  'apps/docs/src/pages/api/account-rate-limits.md',
];

/** `global` is the catch-all; enumerating it would enumerate the API. */
const DEDICATED_BUCKETS = [
  'sessions:create',
  'agent_sessions:message',
  'agent_sessions:input_event',
] as const;

/**
 * Buckets whose consumers are deliberately not enumerated on customer pages.
 * `agent_sessions:input_event` is the high-frequency manual-control stream and
 * is internal-only on the admin-write surface; it is described by purpose
 * rather than by a route list.
 */
const PURPOSE_DESCRIBED_ONLY = new Set<string>(['agent_sessions:input_event']);

function enforcedConsumers(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(resolve(ROUTES_DIR, file), 'utf8');
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
  return DISCLOSURE_PAGES.filter((p) => existsSync(resolve(REPO_ROOT, p))).map((p) => ({
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
