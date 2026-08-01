// The privacy policy's per-surface storage claims, checked against the code.
//
// `legal/privacy.md` makes specific, surface-scoped commitments about client-
// side storage. Two are checkable against source:
//
//   3.9 Status-page data — "Driftstack does **not** set analytics cookies on
//       the status page" and, for that surface, "**Cookies:** none."
//   3.8 Marketing-site data — "does **not** currently set first-party analytics
//       cookies", with strictly-necessary cookies only.
//
// These are not marketing copy. They are the ePrivacy Article 5(3) basis for
// serving those surfaces without a consent mechanism, and Section 3.8 says so
// in as many words. A cookie or a `localStorage` write added to the status page
// would not merely make a page inconsistent with a document — it would remove
// the ground the disclosure stands on, silently, in a repo where nothing was
// looking at that surface. The tracker guard covers marketing-site only, which
// is correct for its own claim ("No trackers on this site" in the footer is
// scoped to that site) but leaves the policy's other surface unchecked.
//
// Both are true today; this was verified before the guard was written, so what
// is being pinned is a property that holds, not a repair.
//
// The last case pins the CLAIM side. A guard that only checks code would keep
// passing if the policy were rewritten to promise something stronger, and that
// is the direction where the compliance exposure lives — the document is what a
// regulator reads. If the claim text changes, this fails and the pair is
// re-examined together rather than drifting apart.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './_helpers/public-apps.js';

const POLICY = resolve(REPO_ROOT, 'apps', 'marketing-site', 'src', 'pages', 'legal', 'privacy.md');

const SCAN_EXTS = ['.astro', '.ts', '.tsx', '.js', '.mjs', '.html'];

/** Client-side storage of the kind ePrivacy Art. 5(3) governs. */
const CLIENT_STORAGE: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'document.cookie', re: /document\s*\.\s*cookie/ },
  { name: 'Set-Cookie header', re: /['"]?Set-Cookie['"]?\s*[:=]/i },
  { name: 'js-cookie', re: /from\s+['"]js-cookie['"]/ },
  { name: 'localStorage', re: /\blocalStorage\b/ },
  { name: 'sessionStorage', re: /\bsessionStorage\b/ },
  { name: 'indexedDB', re: /\bindexedDB\b/ },
];

const ANALYTICS_HOSTS =
  /googletagmanager|google-analytics|gtag\(|mixpanel|hotjar|posthog|segment\.com|facebook\.net|clarity\.ms|matomo|plausible/i;

function sourceFiles(appDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.astro')
        continue;
      const full = resolve(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SCAN_EXTS.some((e) => entry.name.endsWith(e))) out.push(full);
    }
  };
  walk(appDir);
  return out;
}

function statusSiteFiles(): string[] {
  return sourceFiles(resolve(REPO_ROOT, 'apps', 'status-site'));
}

describe('privacy-policy storage claims hold in the code they describe', () => {
  it('CRITICAL the status-site scan reads real files, so "no cookies found" means checked rather than not looked. Every case here asserts an absence, which is the shape that passes loudest when the scan is empty.', () => {
    const files = statusSiteFiles();
    expect(files.length, 'status-site source files scanned').toBeGreaterThan(3);
    expect(
      files.some((f) => f.endsWith('.astro')),
      'at least one page component, not just config',
    ).toBe(true);
  });

  it('CRITICAL the status page sets no cookie and writes no client-side storage. Section 3.9 states "Cookies: none" for that surface, and that disclosure is the ePrivacy Article 5(3) basis for serving it without a consent mechanism — so a localStorage write there is a compliance change, not a UI detail.', () => {
    const hits: string[] = [];
    for (const f of statusSiteFiles()) {
      const src = readFileSync(f, 'utf8');
      for (const { name, re } of CLIENT_STORAGE) {
        if (re.test(src)) hits.push(`${name} in ${f.slice(REPO_ROOT.length + 1)}`);
      }
    }
    expect(hits.sort(), 'client-side storage on a surface the policy says stores nothing:').toEqual(
      [],
    );
  });

  it('CRITICAL the status page loads no analytics origin. A third-party beacon needs no cookie to profile a visitor, so the cookie check above does not cover it and would report clean while the page phoned out.', () => {
    const hits: string[] = [];
    for (const f of statusSiteFiles()) {
      if (ANALYTICS_HOSTS.test(readFileSync(f, 'utf8'))) hits.push(f.slice(REPO_ROOT.length + 1));
    }
    expect(hits.sort(), 'analytics origin(s) referenced by the status page:').toEqual([]);
  });

  it('CRITICAL the errors-site CSP still forbids scripts and outbound connections. errors-site carries no policy section of its own, so its no-tracking property rests entirely on script-src none plus connect-src none; losing either would make it the one public surface with neither a disclosure nor a structural guarantee.', () => {
    const build = readFileSync(resolve(REPO_ROOT, 'apps', 'errors-site', 'build.mjs'), 'utf8');
    expect(build, "script-src 'none' in the emitted CSP").toContain("script-src 'none'");
    expect(build, "connect-src 'none' in the emitted CSP").toContain("connect-src 'none'");
  });

  it('CRITICAL the policy still makes the claims this file verifies. Checking only the code would keep passing if the document were rewritten to promise more than the code delivers, and the document is the side a regulator reads.', () => {
    const policy = readFileSync(POLICY, 'utf8');
    const missing: string[] = [];
    const claims: ReadonlyArray<[string, string]> = [
      ['status page sets no analytics cookies', 'does **not** set analytics cookies on'],
      [
        'marketing site sets no first-party analytics cookies',
        'does **not** currently set first-party analytics cookies',
      ],
      ['a surface declares no cookies at all', '**Cookies:** none.'],
    ];
    for (const [label, text] of claims) {
      if (!policy.includes(text)) missing.push(`${label} — expected text no longer in privacy.md`);
    }
    expect(
      missing.sort(),
      'privacy claim(s) this guard verifies that the policy no longer makes — re-check the pairing rather than deleting the case:',
    ).toEqual([]);
  });
});
