// Drift guard for apps/docs/src/pages/api/mfa.md. Pins the TOTP
// surface, the recovery-code single-use contract, the 15-minute
// step-up window, and the challenge-token-bound-to-IP security
// invariant.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/mfa.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs api/mfa content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Two-factor authentication \(MFA\)/);
    expect(body).toMatch(/description: TOTP enrollment, verification, login challenge/);
  });

  it("TOTP RFC 6238 + single-use recovery codes contract pinned: drift to dropping RFC 6238 reference would orphan customers from the standards anchor; drift to dropping 'single-use' on recovery codes would mislead customers into thinking codes are reusable", () => {
    expect(body).toMatch(/time-based one-time passwords \(TOTP\) per RFC 6238/);
    expect(body).toMatch(/single-use recovery codes/);
    // The "Each code works exactly once" sentence spans 2 lines in
    // a markdown blockquote, so \s allows the `> ` prefix.
    expect(body).toMatch(/Each code works\s*>?\s*exactly once/);
  });

  it("15-minute step-up window pinned: the disabling-MFA-requires-fresh-code-within-15-min contract; drift to dropping this window would either weaken the security posture (longer window) or break customers' UX (shorter window)", () => {
    expect(body).toMatch(/fresh code within a 15-minute window/);
  });

  it('5-endpoint enrollment-and-status surface pinned: enroll / verify / status / disable / regenerate-recovery-codes — drift to dropping any would break the dashboard flow', () => {
    expect(body).toMatch(/`POST \/v1\/account\/mfa\/enroll`/);
    expect(body).toMatch(/`POST \/v1\/account\/mfa\/verify`/);
    expect(body).toMatch(/`GET \/v1\/account\/mfa`/);
    expect(body).toMatch(/`DELETE \/v1\/account\/mfa`/);
  });

  it('login challenge: 5-min single-use IP-bound token pinned (drift to longer window / multi-use / no IP-binding would weaken the post-password gate security posture)', () => {
    expect(body).toMatch(/`POST \/v1\/auth\/mfa\/challenge`/);
    expect(body).toMatch(/valid for 5 minutes, single-use, and bound to the\s+issuing IP address/);
  });

  it('totp-vs-recovery via discriminator pinned in challenge response: via=totp (6-digit match) OR via=recovery (recovery-code consumed) — drift to dropping the discriminator would hide which factor matched, breaking customer audit reconciliation', () => {
    expect(body).toMatch(
      /`via` is `"totp"` when matched against the 6-digit; `"recovery"` when\s+a recovery code was consumed/,
    );
  });

  it('recovery-code "shown ONCE" framing pinned (drift to softening would let customers expect a future regeneration path on the same codes; the regenerate path issues new codes, not the old ones)', () => {
    expect(body).toMatch(/\*\*Recovery codes are shown ONCE\.\*\*/);
    // "account access requires support intervention" spans a
    // blockquote line break.
    expect(body).toMatch(/account\s*>?\s*access requires support intervention/);
  });
});
