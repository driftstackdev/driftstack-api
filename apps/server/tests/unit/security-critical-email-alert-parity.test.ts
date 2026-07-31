// The account-recovery alert covers exactly the templates the code treats as
// security-critical.
//
// `SECURITY_CRITICAL_TEMPLATES` in services/email.ts is the set a customer
// cannot route around: signup verification, password reset, and the OAuth
// pending-verification mail. The code already treats them specially — they get
// a bounded retry the other templates do not — and `SecurityCriticalEmailFailing`
// pages when one of them stops landing.
//
// That alert names them in a regex. A regex in a YAML file has no compiler and
// no test of its own, so adding a fourth security-critical template leaves the
// page silently covering three of four. The failure is the worst shape there
// is: the alert still exists, still fires for the old templates, and looks
// healthy while the new one can fail unnoticed. Nobody discovers it until a
// customer cannot reset their password and nothing pages.
//
// Email is fire-and-forget by design — a send failure never breaks the request
// that triggered it — so this alert is the only thing standing between a
// Postmark outage and customers silently locked out of signup and recovery.
// Which makes the set it covers worth pinning to the set the code uses.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const EMAIL_SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/email.ts');
const ALERTS = resolve(REPO_ROOT, 'ops/alerts/driftstack.yml');

/** The template names the code retries and treats as recovery-critical. */
function securityCriticalTemplates(): string[] {
  const src = readFileSync(EMAIL_SERVICE, 'utf8');
  const block = /const SECURITY_CRITICAL_TEMPLATES = new Set<TemplateName>\(\[([\s\S]*?)\]\)/.exec(
    src,
  );
  if (block === null) throw new Error('SECURITY_CRITICAL_TEMPLATES not found in email.ts');
  return [...block[1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!).sort();
}

/** The template names the paging rule actually matches. */
function alertedTemplates(): string[] {
  const yaml = readFileSync(ALERTS, 'utf8');
  const rule = /- alert: SecurityCriticalEmailFailing[\s\S]*?expr: \|\n([\s\S]*?)\n\s*for:/.exec(
    yaml,
  );
  if (rule === null) throw new Error('SecurityCriticalEmailFailing rule not found');
  const templateMatch = /template=~"([^"]+)"/.exec(rule[1]!);
  if (templateMatch === null) throw new Error('rule has no template matcher');
  return templateMatch[1]!.split('|').sort();
}

describe('the account-recovery email alert covers every security-critical template', () => {
  it('CRITICAL both sides of the comparison were actually found. If either the source set or the alert rule failed to parse, the equality below would be comparing two empty lists and would pass while proving nothing.', () => {
    expect(securityCriticalTemplates().length, 'templates in SECURITY_CRITICAL_TEMPLATES').toBe(3);
    expect(alertedTemplates().length, 'templates matched by the alert regex').toBe(3);
    expect(securityCriticalTemplates(), 'a known one must survive the parse').toContain(
      'password-reset',
    );
  });

  it('CRITICAL the alert matches exactly the code’s set. A fourth security-critical template added without updating the regex leaves the page silently covering three of four — the alert still exists, still fires for the others, and looks healthy while the new one fails unnoticed.', () => {
    expect(
      alertedTemplates(),
      'SecurityCriticalEmailFailing template matcher vs SECURITY_CRITICAL_TEMPLATES:',
    ).toEqual(securityCriticalTemplates());
  });

  it('CRITICAL the rule pages rather than merely records. Email is fire-and-forget, so a send failure never surfaces to the customer or breaks the request that caused it — a warning nobody routes is the same as no alert at all.', () => {
    const yaml = readFileSync(ALERTS, 'utf8');
    const rule = /- alert: SecurityCriticalEmailFailing[\s\S]*?severity: (\w+)/.exec(yaml);
    expect(rule?.[1], 'account-recovery email failure must be critical').toBe('critical');
  });

  it('CRITICAL the rule fires on ANY non-ok outcome rather than on a ratio. One customer permanently unable to reset their password is already the incident, and at low send volume a ratio threshold never trips.', () => {
    const yaml = readFileSync(ALERTS, 'utf8');
    const rule = /- alert: SecurityCriticalEmailFailing[\s\S]*?expr: \|\n([\s\S]*?)\n\s*for:/.exec(
      yaml,
    );
    expect(rule?.[1], 'the expression must exclude ok outcomes').toMatch(/outcome!="ok"/);
    expect(rule?.[1], 'and must not be a ratio').not.toMatch(/\/\s*\n?\s*sum/);
  });
});
