// V-184a.B — drift guard for the verify-email page's URL-token
// auto-submit. The verify URL emitted by the signup email carries
// the token in `?token=…`; the page must read it and submit
// without the user having to copy + paste. If a future edit drops
// this logic, the email-link UX silently regresses to "paste your
// token" — so guard it with a cheap source-string match.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro'),
  'utf8',
);

describe('V-184a.B verify-email page — URL-token auto-submit', () => {
  it('reads `token` from the URL search params', () => {
    expect(PAGE).toContain("params.get('token')");
  });

  it('auto-submits the token when present in the URL', () => {
    // The auto-submit call must reference the variable holding the
    // URL token (named `linkToken` in the current implementation).
    expect(PAGE).toMatch(/submitToken\(\s*linkToken\s*\)/);
  });

  it('falls through to the manual form when no URL token is present', () => {
    // The form's submit handler must still exist as a fallback.
    expect(PAGE).toContain("form.addEventListener('submit'");
  });

  it('does not auto-replay a one-shot token after an ambiguous timeout', () => {
    expect(PAGE).toContain('let verifyOutcomeUnknown = false;');
    expect(PAGE).toContain('verifyInFlight || verifyOutcomeUnknown');
    expect(PAGE).toContain('Do not submit this token again.');
    expect(PAGE).toContain('data-link="verify-timeout-login"');
  });
});
