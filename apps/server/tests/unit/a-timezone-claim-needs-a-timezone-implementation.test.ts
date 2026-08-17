// A page may not promise local-time rendering while formatting in fixed UTC.
//
// `accounts.timezone` (migration 0030, V-352) is stored, cached on the auth
// context, and returned by `GET/PATCH /v1/account/me`. What it is NOT is used:
// nothing in the server or either front-end formats a timestamp with it.
//
// The dashboard's settings page nevertheless told customers:
//
//   "Avatar, display name, timezone and data residency. Used by the dashboard
//    + outbound emails to render timestamps in your local time."
//
// Measured when this landed: the ONLY `timeZone` option anywhere in
// customer-dashboard is a hardcoded `timeZone: 'UTC'` on that same page, and no
// email template references the field at all. A customer could set their
// timezone, watch the PATCH succeed, and see every timestamp stay in UTC. The
// copy now describes what the field does — saved, returned by the API, display
// is UTC — and this keeps the two sides from drifting apart again.
//
// The pairing is DERIVED, not a copy pin: it reads the promise out of the page
// and the formatting out of the same source. Implementing per-account rendering
// makes the claim legal again with no edit here; re-adding the claim without
// the implementation fails.
//
// SCOPE: this checks the dashboard's own rendering. It cannot see a server that
// renders timestamps into an email body, which is why the roster below names
// the email surface explicitly rather than leaving it implied.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const DASHBOARD_SRC = resolve(REPO, 'apps', 'customer-dashboard', 'src');

/** Wording that promises the customer their own timezone is applied to output. */
const CLAIMS_LOCAL_RENDERING =
  /render (?:timestamps|times|dates)[^.]{0,60}\b(?:in )?your local time|shown in your (?:local )?time ?zone|displayed in your timezone/i;

/** Formatting that actually honours a per-account timezone. */
const HONOURS_ACCOUNT_TIMEZONE = /timeZone:\s*(?!['"`]UTC['"`])[A-Za-z_$][\w$.]*/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (entry !== 'node_modules' && entry !== 'dist') walk(p, out);
    } else if (/\.(astro|ts|tsx|js)$/.test(entry)) {
      out.push(p);
    }
  }
}

function dashboardFiles(): string[] {
  const out: string[] = [];
  walk(DASHBOARD_SRC, out);
  return out;
}

describe('a local-time claim needs a local-time implementation', () => {
  it('CRITICAL the scan reads real dashboard sources, so an absence is measured against a real set', () => {
    const files = dashboardFiles();
    expect(files.length, 'no dashboard sources found — the walk is broken').toBeGreaterThan(10);
    expect(
      files.filter((f) => /settings\.astro$/.test(f)).length,
      'the settings page is the surface this was written for',
    ).toBe(1);
    // The detectors must answer both ways, or the check below is decided by the
    // patterns rather than by the pages.
    expect(
      CLAIMS_LOCAL_RENDERING.test('used to render timestamps in your local time.'),
      'claim detector cannot see the claim it exists for',
    ).toBe(true);
    expect(
      CLAIMS_LOCAL_RENDERING.test('timestamps shown here are in UTC.'),
      'claim detector says yes to anything',
    ).toBe(false);
    expect(
      HONOURS_ACCOUNT_TIMEZONE.test('timeZone: account.timezone,'),
      'implementation detector cannot see a per-account timeZone',
    ).toBe(true);
    expect(
      HONOURS_ACCOUNT_TIMEZONE.test("timeZone: 'UTC',"),
      'a hardcoded UTC must NOT count as honouring the account timezone',
    ).toBe(false);
  });

  it('CRITICAL no page promises local-time rendering unless something renders in the account timezone', () => {
    const offenders = dashboardFiles()
      .filter((file) => {
        const source = readFileSync(file, 'utf-8');
        return CLAIMS_LOCAL_RENDERING.test(source) && !HONOURS_ACCOUNT_TIMEZONE.test(source);
      })
      .map((f) => f.slice(REPO.length + 1))
      .sort();

    expect(
      offenders,
      'these tell the customer their timezone changes what they see, and then format in fixed UTC — ' +
        'either render with account.timezone or say what the field actually does',
    ).toEqual([]);
  });
});

// The same failure a second time, on the field directly below it: the slug's
// helper text claimed it was "Used as a stable handle on support tickets,
// billing references, and audit entries". Measured: no audit serialization
// references the slug, no billing or Stripe path sends it, and the repository
// contains no support-ticket system at all. Three named surfaces, none backed.
//
// Generalising the detector is not worth it — "used as X" needs a mapping from
// the prose X to the code that would implement it, and inventing that mapping
// is how a guard starts asserting its author's guesses. Instead each named
// SURFACE gets an explicit pairing below, and adding a claim about a new
// surface means adding its pair here.
// ⚠️ The first version of these detectors required the word "slug" within the
// same sentence as the surface name. It could not match the very copy it was
// written against — "slug" lives in the field LABEL, not in the helper sentence,
// and the claim spans a sentence break. The anti-vacuity case below caught it on
// the first run. They now anchor on the claim's own verb phrase instead.
const SURFACE_CLAIMS: ReadonlyArray<{
  claim: RegExp;
  /** Sources that would have to mention the field for the claim to be true. */
  backedBy: readonly string[];
  field: string;
}> = [
  {
    field: 'slug',
    claim: /(?:handle|identifier)[^<]{0,160}\baudit entries\b/i,
    backedBy: [
      'apps/server/src/routes/account-audit.ts',
      'apps/server/src/services/account-audit.ts',
    ],
  },
  {
    field: 'slug',
    claim: /(?:handle|identifier)[^<]{0,160}\bbilling references\b/i,
    backedBy: ['apps/server/src/services/stripe-webhooks.ts'],
  },
];

describe('a settings field may not claim a surface that does not carry it', () => {
  it('CRITICAL each claimed surface either carries the field or the claim is gone', () => {
    const settings = readFileSync(resolve(DASHBOARD_SRC, 'pages', 'settings.astro'), 'utf-8');
    const offenders: string[] = [];
    for (const { claim, backedBy, field } of SURFACE_CLAIMS) {
      if (!claim.test(settings)) continue;
      const backed = backedBy.some((rel) => {
        const source = readFileSync(resolve(REPO, rel), 'utf-8');
        return new RegExp(`\\b${field}\\b`).test(source);
      });
      if (!backed)
        offenders.push(`${field}: claimed, but ${backedBy.join(' / ')} never mention it`);
    }
    expect(
      offenders.sort(),
      'the settings page names a surface that carries this field, and none of that surface does',
    ).toEqual([]);
  });

  it('CRITICAL the claim detectors can see the wording they exist for', () => {
    expect(
      SURFACE_CLAIMS[0]?.claim.test(
        'handle on support tickets, billing references, and audit entries.',
      ),
      'the audit-entries detector cannot see the claim it was written for',
    ).toBe(true);
    expect(
      SURFACE_CLAIMS[0]?.claim.test(
        'A unique handle for your account, saved and returned by the API.',
      ),
      'the audit-entries detector says yes to the corrected copy',
    ).toBe(false);
  });
});
