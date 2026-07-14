// W350.B — drift guard for /signup. The customer-dashboard signup
// page is the entry point of the V-184a onboarding flow and the
// upstream of three downstream contracts:
//
//   • Password minlength must match AuthPasswordSchema.min(12) so
//     the client-side form rejects what the server would reject.
//   • POST /v1/auth/signup is the registered server route.
//   • On success the page stashes the user's email under
//     `sessionStorage.ds_signup_email`. W348 (#187) resend-verification
//     reads that key to populate the "Resend verification email"
//     button on /verify-email without re-prompting.
//   • ?next= deep-links round-trip through to /verify-email.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthPasswordSchema, SignupRequestSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/signup.astro');
const VERIFY_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Pull the numeric arg from AuthPasswordSchema's .min(<n>) call so the
// parity test catches a server-side bump even if no one updates the
// page. Zod doesn't expose this in a stable public field — read it
// from the source.
function authPasswordMinLength(): number {
  const auth = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
  const m = auth.match(/AuthPasswordSchema\s*=\s*z[\s\S]*?\.min\(\s*(\d+)\s*\)/);
  if (m === null) throw new Error('AuthPasswordSchema.min(...) not found');
  return Number(m[1]!);
}

describe('W350.B /signup page parity', () => {
  const body = read(PAGE);

  it('page file exists at the conventional /signup path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('SignupRequestSchema sanity check (email + password required)', () => {
    expect(SignupRequestSchema.safeParse({}).success).toBe(false);
    expect(
      SignupRequestSchema.safeParse({
        email: 'user@example.com',
        password: 'correct horse battery staple',
      }).success,
    ).toBe(true);
  });

  it('password input minlength matches AuthPasswordSchema.min(N)', () => {
    const n = authPasswordMinLength();
    expect(n).toBeGreaterThanOrEqual(12);
    // The form input + the helper copy both cite the number.
    expect(body).toMatch(new RegExp(`minlength="${n}"`));
    expect(body).toMatch(new RegExp(`${n}\\+ characters`));
    // Zod still enforces the min for the same length.
    expect(AuthPasswordSchema.safeParse('x'.repeat(n - 1)).success).toBe(false);
    expect(AuthPasswordSchema.safeParse('x'.repeat(n)).success).toBe(true);
  });

  it('POSTs to /v1/auth/signup', () => {
    expect(body).toContain("'/v1/auth/signup'");
    const routes = read(AUTH_ROUTE);
    expect(routes).toContain("'/v1/auth/signup'");
  });

  it("stashes the typed email under sessionStorage 'ds_signup_email' (W348 resend depends on it)", () => {
    expect(body).toContain("sessionStorage.setItem('ds_signup_email'");
    // The companion verify-email page reads the same key for the
    // resend button — pin both ends.
    const verify = read(VERIFY_PAGE);
    expect(verify).toContain("readSignupState('ds_signup_email')");
  });

  it('redirects to /verify-email after a successful signup', () => {
    expect(body).toMatch(/window\.location\.href\s*=\s*verificationUrl\(\)/);
    expect(body).toContain("'/verify-email'");
  });

  it('round-trips ?next= through to /verify-email + /login (deep-link preservation), open-redirect guarded', () => {
    // The signup page reads ?next= once, then uses it for both the /login
    // fallback and the shared /verify-email success/timeout recovery URL.
    // Both remain sanitized through inline safeNextPath() (same-origin).
    expect(body).toMatch(
      /'\/login\?next=' \+ encodeURIComponent\(safeNextPath\(nextRaw, window\.location\.origin\)\)/,
    );
    expect(body).toMatch(/'\/verify-email\?next='/);
  });

  it('name field is optional + capped at 120 chars per SignupRequestSchema', () => {
    // The schema allows name as `z.string().min(1).max(120).optional()`
    // — pin both sides.
    expect(body).toContain('name="name"');
    expect(
      SignupRequestSchema.safeParse({
        email: 'user@example.com',
        password: 'correct horse battery staple',
        name: 'x'.repeat(121),
      }).success,
    ).toBe(false);
  });
});
