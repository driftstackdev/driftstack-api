// W369.C — drift guard for status-site /subscribe page content.
// V-657 + V-540.B. Existing status-site-subscribe-page-parity
// test covers route + fetch wiring; this guard pins the load-
// bearing UX + privacy claims:
//
//   • POST /v1/status/subscribe is the registered server route;
//     202 / 400 / 429 status-code branches each render a
//     distinct user-facing message (no silent failure mode).
//   • V-540.B double-opt-in framing pinned (confirmation email
//     before adding to list). A future "skip confirm" change
//     softens GDPR posture and must update this copy first.
//   • "Two emails per incident maximum" volume promise pinned —
//     load-bearing privacy claim that bounds the subscription
//     surface.
//   • "We never send marketing or promotional email from the
//     status list" pinned — distinguishes status list from any
//     marketing list (no cross-mixing).
//   • Unsubscribe affordance: one-click + every-email-carries-
//     a-link claim.
//   • The page is static-served from Cloudflare Pages (light
//     enough to render even when control plane degraded) — pin
//     so a future SSR-conversion forces an explicit decision.
//   • PUBLIC_API_BASE_URL env-var wired for the fetch.
//   • Email-input validation: required + autocomplete="email"
//     + client-side regex sanity check before POST.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/subscribe.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function findRoute(): string {
  // The status-subscribe endpoint may live in any routes file.
  const candidates = [
    'apps/server/src/routes/status-public.ts',
    'apps/server/src/routes/status-subscribers.ts',
    'apps/server/src/routes/status-subscribe.ts',
    'apps/server/src/routes/admin-incidents.ts',
  ];
  for (const c of candidates) {
    const p = resolve(REPO_ROOT, c);
    if (existsSync(p)) {
      const src = readFileSync(p, 'utf8');
      if (src.includes("'/v1/status/subscribe'")) return p;
    }
  }
  throw new Error('/v1/status/subscribe route file not found among candidates');
}

describe('W369.C status-site /subscribe page content parity', () => {
  const body = read(PAGE);

  it('POST /v1/status/subscribe wired client + registered server-side', () => {
    const routePath = findRoute();
    expect(existsSync(routePath)).toBe(true);
    expect(read(routePath)).toContain("'/v1/status/subscribe'");
    expect(body).toMatch(/\/v1\/status\/subscribe/);
    expect(body).toMatch(/method: 'POST'/);
  });

  it('status-code branches: 202 success / 400 invalid email / 429 rate-limit / default error', () => {
    expect(body).toMatch(/res\.status === 202/);
    // Wave 1119 / Slice 1119.3 C1 — the 202 branch swaps the form for a
    // dedicated confirm pane (separate assertion below); no longer
    // surfaces a single setStatus("Check your inbox…") line.
    expect(body).toMatch(/res\.status === 400/);
    expect(body).toMatch(/That doesn't look like a valid email address/);
    expect(body).toMatch(/res\.status === 429/);
    expect(body).toMatch(/Too many subscribe attempts from this IP/);
    expect(body).toMatch(/Subscribe failed \(HTTP \$\{res\.status\}\)\./);
  });

  it('binds custom validation to the email control and focuses both invalid branches', () => {
    expect(body).toMatch(/aria-describedby="subscribe-status"/);
    expect(body).toMatch(/aria-invalid="false"/);
    expect(body).toMatch(/function setEmailValid\(isValid\)/);
    expect(body).toMatch(/emailInput\.setAttribute\('aria-invalid', isValid \? 'false' : 'true'\)/);
    expect(body).toMatch(/if \(!isValid\) emailInput\.focus\(\)/);
    expect(body).toMatch(
      /Please enter a valid email address\.', 'error'\);\s*setEmailValid\(false\)/,
    );
    expect(body).toMatch(
      /That doesn't look like a valid email address\.", 'error'\);\s*setEmailValid\(false\)/,
    );
    expect(body).toMatch(/setEmailValid\(true\);\s*subscribeInFlight = true/);
  });

  it('Wave 1119 / Slice 1119.3 C1 — dedicated confirm pane replaces form on 202 (states the address, the sender to look for status@driftstack.dev, the spam-folder hint, the volume-promise reminder + a "Subscribe another address" affordance)', () => {
    // The pane is hidden initially + revealed on 202.
    expect(body).toMatch(
      /<div\s+id="subscribe-confirm"[\s\S]*?class="[^"]*\bhidden\b[^"]*"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/,
    );
    // Address echo span (so the customer sees which address it was sent to).
    expect(body).toMatch(/Confirmation email sent to <span id="confirm-email"[^>]*><\/span>/);
    // Sender hint (so spam-filter survivors know what to look for).
    expect(body).toMatch(
      /Look for a message from <span class="font-mono">status@driftstack\.dev<\/span>/,
    );
    // Spam-folder fallback.
    expect(body).toMatch(/check your\s+spam folder/);
    // Volume-promise reminder so the customer doesn't need to scroll back up to verify.
    expect(body).toMatch(/2 emails per incident maximum/);
    // "Subscribe another address" button (lets a customer add a teammate without page reload).
    expect(body).toMatch(/<button\s+id="subscribe-another-btn"[\s\S]*?Subscribe another address/);
    // 202 handler swaps the form for the pane.
    expect(body).toMatch(/if \(confirmEmail\) confirmEmail\.textContent = email;/);
    expect(body).toMatch(/if \(confirmPane\) confirmPane\.classList\.remove\('hidden'\);/);
    expect(body).toMatch(/if \(form\) form\.classList\.add\('hidden'\);/);
    // "Subscribe another address" reverts.
    expect(body).toMatch(
      /subscribeAnotherBtn\?\.addEventListener\('click', \(\) => \{\s*\n?\s*if \(confirmPane\) confirmPane\.classList\.add\('hidden'\);\s*\n?\s*if \(form\) form\.classList\.remove\('hidden'\);/,
    );
  });

  it('makes an ambiguous subscribe timeout terminal and inbox-first', () => {
    expect(body).toMatch(/id="subscribe-unknown"/);
    expect(body).toMatch(/let subscribeOutcomeUnknown = false/);
    expect(body).toMatch(/if \(subscribeInFlight \|\| subscribeOutcomeUnknown\) return/);
    expect(body).toMatch(/error && error\.name === 'AbortError'/);
    expect(body).toMatch(/subscribeOutcomeUnknown = true/);
    expect(body).toMatch(/Do not subscribe this address\s+again on this page/);
    expect(body).toMatch(/inbox and spam folder first/);
    expect(body).toMatch(/use the newest one/);
    expect(body).toMatch(
      /if \(!subscribeOutcomeUnknown\) submitBtn\.removeAttribute\('disabled'\)/,
    );
  });

  it('V-540.B double-opt-in framing pinned (confirmation email before list-add)', () => {
    expect(body).toMatch(
      /Double-opt-in: we send a confirmation email to verify the address\s+before adding it to the notification list/,
    );
  });

  it('"Two emails per incident maximum" volume promise pinned', () => {
    expect(body).toMatch(/Two emails\s+per incident maximum/);
  });

  it('"never send marketing or promotional email from the status list" pinned (no cross-mixing)', () => {
    expect(body).toMatch(/We\s+never send marketing or promotional email from the status list/);
  });

  it('unsubscribe affordance pinned (one-click + every-email-carries-a-link)', () => {
    expect(body).toMatch(/Unsubscribe with one\s+click/);
    expect(body).toMatch(/every email carries an unsubscribe link in the footer/);
  });

  it('page is static-served from Cloudflare Pages framing pinned', () => {
    expect(body).toMatch(/the page itself is static-served from Cloudflare\s*\n?\s*\/\/\s*Pages/);
  });

  it('PUBLIC_API_BASE_URL env-var drives the fetch (no hardcoded prod URL)', () => {
    expect(body).toMatch(/import\.meta\.env\.PUBLIC_API_BASE_URL/);
    // Fallback constant pinned too.
    expect(body).toMatch(/'https:\/\/api\.driftstack\.dev'/);
  });

  it('email-input required + autocomplete="email" + client-side regex sanity check', () => {
    expect(body).toMatch(/<input[^>]*id="email-input"[\s\S]*?required/);
    expect(body).toMatch(/<input[^>]*id="email-input"[\s\S]*?autocomplete="email"/);
    // Client-side regex (defensive — server still validates).
    expect(body).toMatch(/\/\^\.\+@\.\+\\\.\.\+\$\//);
  });

  it("'service-status incident' framing — not marketing comms", () => {
    // Pin so a future "we'll also email you about new features"
    // copy add forces a discussion about the status-list scope.
    expect(body).toMatch(
      /We'll email you when we post a service-status incident, and again\s+when it resolves/,
    );
  });

  it('V-657 comment pinned (V-540.B-11-tested double-opt-in flow)', () => {
    expect(body).toMatch(/V-657 — incident-email subscription handler/);
    expect(body).toMatch(/V-540\.B-11-tested\s*\n?\s*\/\/\s*double-opt-in flow/);
  });
});
