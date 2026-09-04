// Drift guard for apps/marketing-site/public/.well-known/security.txt
// (RFC 9116 responsible-disclosure metadata served at
// https://driftstack.io/.well-known/security.txt).
//
// Why this guard exists: the published coordinated-disclosure policy
// (apps/marketing-site/src/pages/legal/vulnerability-disclosure.md) directs
// researchers to THIS file by its canonical URL, and the DPA commits to a
// "published mechanism … at security@driftstack.dev". If this file is
// deleted or its Contact/Policy drift, the policy's promise breaks and
// researchers hit a 404 / a wrong contact. RFC 9116 also REQUIRES the
// Contact + Expires fields, so pin their presence.
//
// Deliberately does NOT assert the Expires date is in the future — that
// would be a time-bomb test that starts failing once the date passes.
// Renewal is a documented operational task (the file's own comment); this
// guard pins STRUCTURE (the field is present + well-formed), not freshness.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FILE = resolve(REPO_ROOT, 'apps/marketing-site/public/.well-known/security.txt');

describe('marketing-site /.well-known/security.txt content parity (RFC 9116)', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true);
  });

  const body = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';

  it('Contact: points to the established security@driftstack.dev (RFC 9116 required field)', () => {
    expect(body).toMatch(/^Contact: mailto:security@driftstack\.dev$/m);
  });

  it('Expires: field present + ISO-8601 UTC (RFC 9116 required field) — value not asserted (renewal is operational, not a test time-bomb)', () => {
    expect(body).toMatch(/^Expires: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/m);
  });

  it('Policy: points to the coordinated-disclosure policy page (which references this file)', () => {
    expect(body).toMatch(/^Policy: https:\/\/driftstack\.io\/legal\/vulnerability-disclosure\/$/m);
  });

  it('Canonical: matches the URL the disclosure policy directs researchers to', () => {
    expect(body).toMatch(/^Canonical: https:\/\/driftstack\.io\/\.well-known\/security\.txt$/m);
  });

  // Cross-source link-rot guard: the Policy: URL points at a /legal/<slug> page;
  // assert the backing marketing-site source page actually exists. Motivated by
  // a PROVEN bug class in this repo — the same disclosure policy links a
  // /legal/security-research-honour-roll page that 404s (queue §4.19). Without
  // this, renaming/removing the disclosure-policy page would silently turn the
  // security.txt Policy: link (a published, researcher-followed URL) into a 404.
  it("Policy: target /legal/<slug> page exists in the marketing site (link-rot guard — re-derived from the security.txt's actual Policy URL)", () => {
    const m = body.match(/^Policy: https:\/\/driftstack\.io\/legal\/([a-z0-9-]+)\/?$/m);
    expect(m, 'security.txt must carry a /legal/<slug> Policy URL').not.toBeNull();
    const slug = m![1];
    const page = resolve(REPO_ROOT, `apps/marketing-site/src/pages/legal/${slug}.md`);
    expect(
      existsSync(page),
      `security.txt Policy points to /legal/${slug} but apps/marketing-site/src/pages/legal/${slug}.md does not exist (link would 404)`,
    ).toBe(true);
  });
});
