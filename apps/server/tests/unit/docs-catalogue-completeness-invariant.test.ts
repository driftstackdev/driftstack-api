// Catalogue-completeness invariant (A2, 2026-07-31).
//
// The converse of `docs-public-surface-resolves`. That guard proves the docs
// never name something that does not exist. This one proves the docs never
// OMIT something that does — for the three catalogues where a customer's
// integration depends on the list being whole, and where a page makes an
// explicit completeness promise:
//
//   1. `reference/errors.md` says "Every Driftstack RFC 9457 problem-type".
//      A customer switching on `type` needs that to be literally true; a
//      problem type added to `problem.ts` without a page entry makes the page
//      lie and leaves an unhandled branch in customer code.
//   2. Every webhook event type must be documented somewhere customer-facing —
//      an undocumented event arrives at a customer endpoint they never built a
//      handler for.
//   3. Every account tier must appear in the sessions concurrency table, which
//      is what customers size their integration against.
//
// All three currently hold; this keeps them holding.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function allCustomerDocText(): string {
  let out = '';
  for (const root of ['apps/docs/src/pages', 'apps/marketing-site/src/pages']) {
    const base = resolve(REPO_ROOT, root);
    if (!existsSync(base)) continue;
    const stack = [base];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) stack.push(full);
        else if (entry.endsWith('.md') || entry.endsWith('.astro'))
          out += readFileSync(full, 'utf8');
      }
    }
  }
  return out;
}

const PROBLEM_TYPE_RE = /errors\.driftstack\.dev\/([a-z0-9-]+)/g;

describe('customer-facing catalogues are complete, not just consistent', () => {
  it('CRITICAL reference/errors.md lists EXACTLY the canonical problem-type set. Its own description promises "Every Driftstack RFC 9457 problem-type"; a type added to problem.ts without a page entry turns that promise into a lie and leaves customers switching on `type` with an unhandled branch.', () => {
    const canonical = new Set(
      [...read('packages/api-types/src/problem.ts').matchAll(PROBLEM_TYPE_RE)].map((m) => m[1]!),
    );
    const page = read('apps/docs/src/pages/reference/errors.md');
    const documented = new Set([...page.matchAll(PROBLEM_TYPE_RE)].map((m) => m[1]!));

    expect(canonical.size).toBeGreaterThan(25);
    // The promise itself must stay on the page — if someone weakens it to
    // "common problem types", this assertion should be revisited deliberately
    // rather than the set check silently becoming pointless.
    expect(page).toMatch(/Every Driftstack RFC 9457 problem-type/);

    const missing = [...canonical].filter((t) => !documented.has(t)).sort();
    const phantom = [...documented].filter((t) => !canonical.has(t)).sort();
    expect(
      missing,
      'Problem type(s) defined in problem.ts but absent from the error reference:',
    ).toEqual([]);
    expect(phantom, 'Error reference documents (a) problem type(s) that do not exist:').toEqual([]);
  });

  it('CRITICAL every webhook event type is documented somewhere customer-facing. An undocumented event still gets DELIVERED — it arrives at an endpoint the customer never wrote a handler for.', () => {
    const webhooks = read('packages/api-types/src/webhooks.ts');
    const events = [...new Set([...webhooks.matchAll(/'([a-z_]+\.[a-z_.]+)'/g)].map((m) => m[1]!))];
    expect(events.length).toBeGreaterThan(5);

    const docs = allCustomerDocText();
    const undocumented = events.filter((e) => !docs.includes(e)).sort();
    expect(undocumented, 'Webhook event type(s) that are delivered but never documented:').toEqual(
      [],
    );
  });

  it('CRITICAL every account tier appears in the sessions concurrency table. Customers size their integration against that table; a tier missing from it has no published concurrent-session cap.', () => {
    const common = read('packages/api-types/src/common.ts');
    const block = /AccountTierSchema = z\.enum\(\[([\s\S]*?)\]\)/.exec(common);
    expect(block, 'AccountTierSchema enum not found').not.toBeNull();
    const tiers = [...block![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(tiers.length).toBeGreaterThan(5);

    const page = read('apps/docs/src/pages/api/sessions.md');
    const missing = tiers.filter((t) => !page.includes(`\`${t}\``)).sort();
    expect(missing, 'Tier(s) with no row in the published concurrency table:').toEqual([]);
  });
});
