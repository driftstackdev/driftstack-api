// W191 — drift guard against re-introducing hardcoded customer-facing
// URL literals in the email-templates module.
//
// Every customer-facing URL in `apps/server/src/services/email.ts`
// must come in via template variables (e.g. `${v.link}`,
// `${v.dashboardUrl}`, `${v.portalUrl}`). If a future edit drops a
// raw `https://app.driftstack.dev` literal into the templates, the
// V-079.B + W190 normalisation in `config.ts` can't reach into the
// template body, and the same 2026-05-12 Postmark-link bug class
// becomes possible again.
//
// The grep is intentionally blunt; jsdoc/comment lines are allowlisted.
//
// V-956 — the substring allowlist that used to sit here held two entries,
// `driftstack.dev/docs` and `driftstack.dev/legal`, justified in this comment as
// "separate origins not driven by DASHBOARD_ORIGIN". Neither string occurs
// anywhere in `services/email.ts`, and neither could have mattered if it did: the
// allowlist is only consulted for lines already containing `app.driftstack.dev`
// or `localhost:5173`. They excused nothing. Removed, with an arm below requiring
// any future entry to actually excuse a line this guard would otherwise flag.
//
// The other half was missing rather than dead. Both arms report an ABSENCE — an
// empty offender list — so a guard reading nothing passes exactly like a clean
// file. The sibling `bootstrap-url-literals-guard` has a positive arm for this
// (`reads config.dashboardOrigin at least once`); this one had none. It does now,
// and it asserts the thing the module comment above actually promises: that the
// customer-facing URLs arrive through template variables.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const EMAIL = resolve(HERE, '..', '..', 'src', 'services', 'email.ts');

const SOURCE = readFileSync(EMAIL, 'utf8');

const COMMENT_PATTERNS = [/^\s*\/\//, /^\s*\*/];

/**
 * Substrings that excuse a line which otherwise trips a trigger below.
 *
 * Empty, and it should stay that way unless a real case appears — an entry here
 * is only meaningful on a line that ALSO contains `app.driftstack.dev` or
 * `localhost:5173`, which is a narrow thing to need. The arm below refuses an
 * entry that does not excuse such a line, so this cannot quietly refill with
 * plausible-looking origins the way it did before.
 */
const SUBSTRING_ALLOWLIST: readonly string[] = [];

/** The two literals this guard exists to keep out of the templates. */
const TRIGGERS = ['app.driftstack.dev', 'localhost:5173'] as const;

function isAllowedLine(line: string): boolean {
  if (COMMENT_PATTERNS.some((re) => re.test(line))) return true;
  return SUBSTRING_ALLOWLIST.some((s) => line.includes(s));
}

describe('W191 email-templates URL-literal drift guard', () => {
  it('CRITICAL the scan read the real module, and the templates thread their URLs through variables. Both arms below report an ABSENCE, so a wrong path, an emptied file or a rewritten module would pass them having examined nothing — which is how a guard keeps reporting all-clear over a file it no longer describes.', () => {
    expect(SOURCE.length, 'characters read from services/email.ts').toBeGreaterThan(10_000);
    // The promise in this file's header: customer-facing URLs arrive as template
    // variables. Named individually rather than counted, so swapping one for
    // another cannot pass.
    // The INTERPOLATION form, not the bare name: `SOURCE.toContain('v.portalUrl')`
    // is satisfied by `v.portalUrlRenamed`, so a rename — the exact drift this
    // arm is for — passed it. Measured, not theorised: that mutation went green.
    for (const usage of ['${v.link}', '${v.dashboardUrl}', '${v.portalUrl}']) {
      expect(SOURCE, `${usage} is still how a URL reaches the templates`).toContain(usage);
    }
    // And the triggers are detectable at all: the module carries one commented
    // mention of the dashboard origin, which the comment rule is what excuses.
    expect(
      SOURCE.split('\n').filter((line) => line.includes(TRIGGERS[0])).length,
      'lines mentioning the dashboard origin (the comment rule is what clears it)',
    ).toBeGreaterThan(0);
  });

  it('CRITICAL every substring allowlist entry actually excuses a line this guard would otherwise flag. The list it replaces held two entries that matched nothing in the scanned file and could not have mattered if they had — the allowlist is only consulted for lines already containing a trigger. An exemption that excuses nothing is not harmless: it reads as considered, and it is the seam a broader entry slips in through.', () => {
    const unused = SUBSTRING_ALLOWLIST.filter(
      (entry) =>
        !SOURCE.split('\n').some(
          (line) => line.includes(entry) && TRIGGERS.some((t) => line.includes(t)),
        ),
    );
    expect(
      unused,
      'these allowlist entries do not excuse any line carrying a trigger, so they are dead weight:',
    ).toEqual([]);
  });

  it('contains no `https://app.driftstack.dev` literals', () => {
    const offenders = SOURCE.split('\n')
      .map((line, idx) => ({ line, lineNumber: idx + 1 }))
      .filter(({ line }) => line.includes('app.driftstack.dev'))
      .filter(({ line }) => !isAllowedLine(line));
    expect(
      offenders,
      `apps/server/src/services/email.ts must not hardcode the dashboard origin. ` +
        `Thread the URL through the template variables (v.link / v.dashboardUrl / v.portalUrl). ` +
        `Offending lines:\n${offenders.map((o) => `  L${o.lineNumber.toString()}: ${o.line.trim()}`).join('\n')}`,
    ).toEqual([]);
  });

  it('contains no `localhost:5173` literals', () => {
    const offenders = SOURCE.split('\n')
      .map((line, idx) => ({ line, lineNumber: idx + 1 }))
      .filter(({ line }) => line.includes('localhost:5173'))
      .filter(({ line }) => !isAllowedLine(line));
    expect(
      offenders,
      `apps/server/src/services/email.ts must not hardcode dev-mode URLs. ` +
        `Offending lines:\n${offenders.map((o) => `  L${o.lineNumber.toString()}: ${o.line.trim()}`).join('\n')}`,
    ).toEqual([]);
  });
});
