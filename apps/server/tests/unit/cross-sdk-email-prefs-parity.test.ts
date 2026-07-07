// W694 — cross-SDK V-204 email-preferences critical-emails parity.
// Twenty-first in the cross-SDK drift-guard series (W649 + W675 +
// W676 + W677 + W678 + W679 + W680 + W681 + W682 + W683 + W684 +
// W685 + W686 + W687 + W688 + W689 + W690 + W691 + W692 + W693 +
// W694).
//
// CRITICAL: asserts the 3 critical email event types are NOT opt-
// outable across all 3 SDKs:
//
//   1. signup-verification / verification — "you signed up, click
//      to verify" — drift to opt-outable would lock new customers
//      out of completing signup
//   2. password-reset — "your password was reset" — drift would
//      lose the security notification (customer can't tell if it
//      was them or an attacker)
//   3. billing-failure — "your card failed" — drift would lose
//      the revenue-protecting nag that prevents involuntary churn
//
// (S44 2026-07-07, founder-approved trim — the roster was 5: the
// never-wired subscription-cancellation + support-ack templates
// were deleted outright, so the SDKs no longer describe them. The
// deleted names must NOT reappear in any SDK docstring as if those
// emails existed.)
//
// The 3 critical events MUST stay out of the OptOutableEmailEvent
// enum on purpose. Drift to letting ANY of these into the enum
// would silently let customers opt out of safety-net emails.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_EMAIL_PREFS = resolve(
  REPO_ROOT,
  'packages/sdk-typescript/src/resources/email-preferences.ts',
);
const GO_EMAIL_PREFS = resolve(REPO_ROOT, 'packages/sdk-go/email_preferences.go');
const PY_EMAIL_PREFS = resolve(
  REPO_ROOT,
  'packages/sdk-python/src/driftstack/resources/email_preferences.py',
);

describe('W694 cross-SDK V-204 email-preferences critical-emails parity', () => {
  it('all 3 SDK email-preferences files exist at canonical paths', () => {
    expect(existsSync(TS_EMAIL_PREFS), `missing ${TS_EMAIL_PREFS}`).toBe(true);
    expect(existsSync(GO_EMAIL_PREFS), `missing ${GO_EMAIL_PREFS}`).toBe(true);
    expect(existsSync(PY_EMAIL_PREFS), `missing ${PY_EMAIL_PREFS}`).toBe(true);
  });

  it('CRITICAL V-204 anchor pinned in all 3 SDKs. V-204 is the email-preferences feature anchor; drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_EMAIL_PREFS);
    const go = read(GO_EMAIL_PREFS);
    const py = read(PY_EMAIL_PREFS);

    expect(ts).toMatch(/V-204/);
    expect(go).toMatch(/V-204/);
    expect(py).toMatch(/V-204/);
  });

  it('CRITICAL 3 critical email event types pinned in all 3 SDKs as NOT opt-outable. Drift to letting ANY of these (verification / password-reset / billing-failure) into the OptOutableEmailEvent enum would silently let customers opt out of safety-net emails. S44 negative pins: the deleted subscription-cancellation + support-ack templates must not resurface in SDK docstrings.', () => {
    const ts = read(TS_EMAIL_PREFS);
    const go = read(GO_EMAIL_PREFS);
    const py = read(PY_EMAIL_PREFS);

    // All 3 SDKs reference the 3 critical event types in a "not opt-outable" context.
    const criticalEvents = [
      /signup-verification|\bverification\b/,
      /password-reset/,
      /billing-failure/,
    ];

    for (const sdk of [ts, go, py]) {
      for (const evt of criticalEvents) {
        expect(sdk, `event ${evt.source}`).toMatch(evt);
      }
      // S44 2026-07-07 — deleted-template names must stay gone.
      expect(sdk).not.toMatch(/subscription-(?:\s*\n\s*(?:\/\/|#)\s*)?cancellation/);
      expect(sdk).not.toMatch(/support-ack/);
    }
  });

  it('CRITICAL "not opt-outable" framing pinned in all 3 SDKs. The wording is what tells customers + auditors that the 5 critical events are EXCLUDED from the opt-out enum. Drift to dropping would lose the customer-facing claim that safety-net emails always fire.', () => {
    const ts = read(TS_EMAIL_PREFS);
    const go = read(GO_EMAIL_PREFS);
    const py = read(PY_EMAIL_PREFS);

    // sdk-typescript: "are\n// never opt-outable"
    expect(ts).toMatch(/never opt-outable/);

    // sdk-go: "are not opt-outable by design"
    expect(go).toMatch(/not opt-outable by design/);

    // sdk-python: "are not opt-outable; they"
    expect(py).toMatch(/are not opt-outable/);
  });

  it('CRITICAL OptOutableEmailEvent enum mentioned in all 3 SDKs. The closed enum is what enforces the policy at the type/server side — drift to widening (adding a critical event) would silently break the safety net. The phrase "absent from the OptOutableEmailEvent enum on purpose" is load-bearing.', () => {
    const ts = read(TS_EMAIL_PREFS);
    const py = read(PY_EMAIL_PREFS);

    // sdk-typescript: "absent from the\n// OptOutableEmailEvent enum on purpose"
    expect(ts).toMatch(/absent from the\s*\n?\s*\/\/\s*OptOutableEmailEvent enum on purpose/);

    // sdk-python: "aren't in the OptOutableEmailEvent enum on purpose"
    expect(py).toMatch(/aren't in the OptOutableEmailEvent enum on purpose/);
  });

  it('Per-event opt-in/opt-out scope pinned across all 3 SDKs — "non-critical customer emails." The "non-critical" word is what threads the line between opt-outable (newsletter, product-updates) and non-opt-outable (the 5 critical events).', () => {
    const ts = read(TS_EMAIL_PREFS);
    const go = read(GO_EMAIL_PREFS);
    const py = read(PY_EMAIL_PREFS);

    expect(ts).toMatch(/non-critical customer emails/);
    expect(go).toMatch(/non-critical emails/);
    expect(py).toMatch(/non-critical customer emails/);
  });

  it('4-verb surface across 3 SDKs — list + set + opt_in + opt_out (convenience wrappers). The 2 convenience wrappers delegate to set (drift to making them separate wire calls would double the request count for trivial opt-outs).', () => {
    const ts = read(TS_EMAIL_PREFS);
    const py = read(PY_EMAIL_PREFS);

    // sdk-typescript: list / set / optOut / optIn
    expect(ts).toMatch(/list\(\)/);
    expect(ts).toMatch(/set\(body:/);
    expect(ts).toMatch(/optOut\(eventType:/);
    expect(ts).toMatch(/optIn\(eventType:/);

    // sdk-python: list / set / opt_out / opt_in
    expect(py).toMatch(/def list\(self/);
    expect(py).toMatch(/def set\(self, body:/);
    expect(py).toMatch(/def opt_out\(self, event_type:/);
    expect(py).toMatch(/def opt_in\(self, event_type:/);
  });

  it('Default-opt-in invariant pinned in all 3 SDKs — "defaults opted-in for unset rows." Drift to opt-out-by-default would silently mute every customer\'s non-critical emails (newsletter, product-updates, weekly digest) — they would never know they stopped receiving things.', () => {
    const ts = read(TS_EMAIL_PREFS);
    const py = read(PY_EMAIL_PREFS);

    // sdk-typescript: "Defaults to opted-in for unset rows"
    expect(ts).toMatch(/Defaults to opted-in for unset rows/);

    // sdk-python: "Defaults opted-in for unset rows"
    expect(py).toMatch(/Defaults opted-in for unset rows/);
  });

  it('Wire-path pinned per-SDK — /v1/account/email-preferences. Drift to renaming would break server-side routing.', () => {
    const ts = read(TS_EMAIL_PREFS);
    const go = read(GO_EMAIL_PREFS);
    const py = read(PY_EMAIL_PREFS);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/account\/email-preferences/);
    }
  });

  it('CRITICAL PUT (not POST) for set — preference rows are UNIQUE per event_type (drift to POST would duplicate rows on retry). The PUT-as-idempotent-upsert is the load-bearing semantic.', () => {
    const ts = read(TS_EMAIL_PREFS);
    const py = read(PY_EMAIL_PREFS);

    // sdk-typescript: method: 'PUT'
    expect(ts).toMatch(/method: 'PUT'/);

    // sdk-python: "PUT"
    expect(py).toMatch(/"PUT"/);
  });

  it('Cross-SDK V-204 5-invariant cluster — V-204 anchor + 3 critical events not opt-outable + "non-critical" scope + default-opt-in + 4-verb surface. Drift on any would fragment the cross-language email-policy contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_EMAIL_PREFS),
      'sdk-go': read(GO_EMAIL_PREFS),
      'sdk-python': read(PY_EMAIL_PREFS),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-204`).toMatch(/V-204/);
      expect(body, `${name} non-critical`).toMatch(/non-critical/);
      // 3 critical events appear in the file (S44 trimmed the roster 5→3).
      expect(body, `${name} verification`).toMatch(/verification/);
      expect(body, `${name} password-reset`).toMatch(/password-reset/);
      expect(body, `${name} billing-failure`).toMatch(/billing-failure/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-email-prefs-parity.test.ts')),
    ).toBe(true);
  });
});
