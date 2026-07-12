// Drift guard: the four credential auth forms (login, signup,
// forgot-password, reset-password) must disable their submit button and
// show a pending label while the request is in flight. Without it the
// button gives no feedback on a slow network and is double-submittable
// (signup → confusing "already exists"; forgot-password → duplicate reset
// emails). verify-email already does its own pending handling; these four
// were the gap (added 2026-05-30).
//
// Robustness pin: re-enable runs from `.finally(...)` so the button can
// never get stuck disabled, and reset-password (which has client-side
// validation early-returns) must toggle submitting ON only at/after the
// fetch — pinned implicitly by requiring setSubmitting(true) to sit with
// the fetch call, not before the validation.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(HERE, '..', '..', 'src', 'pages');

const FORMS: Array<{ file: string; pending: string }> = [
  { file: 'login.astro', pending: 'Signing in…' },
  { file: 'signup.astro', pending: 'Creating account…' },
  { file: 'forgot-password.astro', pending: 'Sending…' },
  { file: 'reset-password.astro', pending: 'Resetting…' },
];

describe('auth forms submit pending-state parity', () => {
  for (const { file, pending } of FORMS) {
    describe(file, () => {
      const body = readFileSync(resolve(PAGES, file), 'utf8');

      it('captures the submit button + defines setSubmitting (disabled + aria-busy + pending label)', () => {
        expect(body).toMatch(/form\.querySelector\('button\[type="submit"\]'\)/);
        expect(body).toMatch(/function setSubmitting\(on\)/);
        expect(body).toMatch(/submitBtn\.disabled = on;/);
        expect(body).toMatch(/submitBtn\.setAttribute\('aria-busy', on \? 'true' : 'false'\);/);
        expect(body).toContain(pending);
      });

      it('toggles submitting ON during the request and re-enables via .finally (never stuck disabled)', () => {
        expect(body).toMatch(/setSubmitting\(true\);/);
        expect(body).toMatch(/\.finally\(\(\) =>\s*(?:\{[\s\S]*?)?setSubmitting\(false\)/);
      });
    });
  }

  it('reset-password enables submitting only after its client-side validation (so an early-return cannot stick the button)', () => {
    const body = readFileSync(resolve(PAGES, 'reset-password.astro'), 'utf8');
    // The min-length guard returns before the fetch; setSubmitting(true)
    // must appear AFTER that guard, immediately before the fetch.
    const guardIdx = body.indexOf('Password must be at least 12 characters.');
    const submittingIdx = body.indexOf('setSubmitting(true);');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(submittingIdx).toBeGreaterThan(guardIdx);
  });
});
