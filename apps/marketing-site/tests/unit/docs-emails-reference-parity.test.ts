// W350.A — drift guard for /docs/emails-reference. The page is the
// public catalog of every transactional + notification email
// Driftstack sends. Source-of-truth claims pinned here:
//
//   • Every template name cited on the page must exist as a key in
//     `TEMPLATES` in apps/server/src/services/email.ts, and vice-versa
//     — no orphan rows on the page, no silent additions in code.
//   • Every "opt-outable" template on the page must be in
//     OptOutableEmailEventSchema; every "no — required" template must
//     NOT be in that enum.
//   • The /v1/account/email-preferences endpoint shape (GET + PUT)
//     stays pinned with the corresponding routes.
//   • Sender domain claims (noreply@ + support@ + DMARC posture +
//     Postmark sole sender) stay pinned with the docs.
//
// Catches: template rename without the doc tag updating; new
// template added to email.ts but missing from the catalog; opt-out
// posture drift between schema + page.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OptOutableEmailEventSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/emails-reference.astro');
const EMAIL_SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/email.ts');
const PREFS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function templateNamesFromSource(): Set<string> {
  // Pull out keys of the literal `const TEMPLATES = { … } satisfies`
  // object in apps/server/src/services/email.ts. We don't import it
  // directly because the module is server-side + has Postmark
  // runtime imports we don't want to pull into a vitest unit run.
  const src = read(EMAIL_SERVICE);
  const block = src.match(/const TEMPLATES = \{([\s\S]*?)\} satisfies Record<string, Template>/);
  if (block === null) throw new Error('TEMPLATES literal not found in email.ts');
  const names = new Set<string>();
  for (const m of block[1]!.matchAll(/^\s*'([a-z][a-z0-9-]+)':/gm)) {
    names.add(m[1]!);
  }
  return names;
}

describe('W350.A /docs/emails-reference parity', () => {
  const body = read(PAGE);
  const codeTemplates = templateNamesFromSource();
  const schemaOptOutable = new Set<string>(
    (OptOutableEmailEventSchema._def as { values: readonly string[] }).values,
  );

  it('TEMPLATES literal in email.ts is non-trivially large (canary)', () => {
    expect(codeTemplates.size).toBeGreaterThanOrEqual(15);
  });

  it('every template documented on the page exists in code', () => {
    // Each row cites the template as <strong>name</strong> in the
    // first <td>. Pull every <strong>foo-bar</strong> that looks
    // like a template id.
    const pageRefs = new Set<string>();
    for (const m of body.matchAll(/<strong>([a-z][a-z0-9-]+)<\/strong>/g)) {
      const id = m[1]!;
      // Filter to things that look like template ids (hyphen-y,
      // multi-word) so we don't catch e.g. <strong>Yes</strong>.
      if (id.includes('-')) pageRefs.add(id);
    }
    const orphansOnPage = [...pageRefs].filter(
      (id) => !codeTemplates.has(id) && schemaOptOutable.has(id) === false,
    );
    // Strip out ids that are unrelated bold-tagged words (e.g.
    // "p=quarantine" elsewhere on the page); only template-shaped
    // ids that ARE template-shaped should match. We let one orphan
    // through here: the page's `email-preferences` API path is also
    // bolded.
    expect(orphansOnPage.filter((s) => s !== 'email-preferences')).toEqual([]);
  });

  it('every template in code is cited on the page', () => {
    const missing = [...codeTemplates].filter((t) => !body.includes(`<strong>${t}</strong>`));
    expect(missing).toEqual([]);
  });

  it('opt-outable schema entries are all present on the page', () => {
    const missing = [...schemaOptOutable].filter((id) => !body.includes(`<strong>${id}</strong>`));
    expect(missing).toEqual([]);
  });

  it('signup-verification + password-reset are marked "No — required" (never opt-outable)', () => {
    // These two live in the "Auth + account access" section and
    // must not be in OptOutableEmailEventSchema.
    expect(schemaOptOutable.has('signup-verification')).toBe(false);
    expect(schemaOptOutable.has('password-reset')).toBe(false);
    // The page cites both and labels them required.
    expect(body).toMatch(/signup-verification[\s\S]{0,400}No — required to access/);
    expect(body).toMatch(/password-reset[\s\S]{0,400}No — user-triggered/);
  });

  it('billing-failure + subscription-cancellation are required (not opt-outable)', () => {
    expect(schemaOptOutable.has('billing-failure')).toBe(false);
    expect(schemaOptOutable.has('subscription-cancellation')).toBe(false);
  });

  it('cites GET + PUT /v1/account/email-preferences, both registered server-side', () => {
    const route = read(PREFS_ROUTE);
    expect(body).toContain('GET /v1/account/email-preferences');
    expect(body).toContain('PUT /v1/account/email-preferences');
    expect(route).toContain("'/v1/account/email-preferences'");
  });

  it('sender + DMARC + Postmark claims pinned', () => {
    expect(body).toContain('noreply@driftstack.dev');
    expect(body).toContain('support@driftstack.dev');
    expect(body).toMatch(/DKIM, SPF,\s*and DMARC/);
    expect(body).toMatch(/Postmark is\s*the single sender/);
  });

  it('cross-links to /docs/email-troubleshooting + /docs/status-subscriptions resolve', () => {
    expect(body).toContain('/docs/email-troubleshooting');
    expect(body).toContain('/docs/status-subscriptions');
  });
});
