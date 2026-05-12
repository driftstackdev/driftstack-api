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
// The grep is intentionally blunt; jsdoc/comment lines and the
// `driftstack.dev/docs` static doc origin are allowlisted because
// they're separate origins not driven by DASHBOARD_ORIGIN.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const EMAIL = resolve(HERE, '..', '..', 'src', 'services', 'email.ts');

const SOURCE = readFileSync(EMAIL, 'utf8');

const COMMENT_PATTERNS = [/^\s*\/\//, /^\s*\*/];

const SUBSTRING_ALLOWLIST = [
  'driftstack.dev/docs', // separate marketing-site origin
  'driftstack.dev/legal', // legal pages on marketing site
];

function isAllowedLine(line: string): boolean {
  if (COMMENT_PATTERNS.some((re) => re.test(line))) return true;
  return SUBSTRING_ALLOWLIST.some((s) => line.includes(s));
}

describe('W191 email-templates URL-literal drift guard', () => {
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
