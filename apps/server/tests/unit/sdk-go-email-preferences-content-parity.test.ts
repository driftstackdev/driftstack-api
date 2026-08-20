// W592.C — drift guard for packages/sdk-go/email_preferences.go.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/email_preferences.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W592.C packages/sdk-go/email_preferences.go content parity', () => {
  const body = read(LIB);

  it('V-204 EmailPreferencesResource + critical-emails-not-opt-outable rationale + 4 verbs (List default-opted-in + Set PUT + OptOut/OptIn convenience wrappers) pinned', () => {
    expect(body).toMatch(
      /\/\/ EmailPreferencesResource handles \/v1\/account\/email-preferences \(V-204\)\./,
    );
    expect(body).toMatch(
      /\/\/ Per-event opt-in\/opt-out for non-critical emails\. Critical emails/,
    );
    // S44 2026-07-07 (founder-approved trim) — critical-email roster
    // shrank 5→3: the never-wired subscription-cancellation +
    // support-ack templates were deleted outright.
    expect(body).toMatch(/\/\/ \(verification \/ password-reset \/ billing-failure\) are/);
    expect(body).toMatch(/\/\/ not opt-outable by design\./);
    expect(body).not.toMatch(/subscription-cancellation|support-ack/);
    expect(body).toMatch(
      /^type EmailPreference struct \{\s*\n\s*EventType string `json:"event_type"`\s*\n\s*OptedIn\s+bool\s+`json:"opted_in"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /\/\/ List returns all opt-out toggles for the EFFECTIVE account\. Defaults/,
    );
    expect(body).toMatch(/\/\/ opted-in for unset rows\./);
    expect(body).toMatch(/path:\s+"\/v1\/account\/email-preferences",/);
    expect(body).toMatch(/method: "PUT",/);
    expect(body).toMatch(/\/\/ OptOut is a convenience wrapper for Set with opted_in=false\./);
    // Set + OptOut + OptIn return only `error` (no *EmailPreference)
    // because the server replies 204 No Content. The previous pin
    // asserted `(*EmailPreference, error)` which was source-of-truth-
    // divergent — customer Go code unmarshalling `pref.EventType` from
    // a nil-EmailPreference would panic. Call List() if the
    // post-update state is needed.
    expect(body).toMatch(
      /func \(r \*EmailPreferencesResource\) OptOut\(ctx context\.Context, eventType string\) error \{\s*\n\s*return r\.Set\(ctx, &SetEmailPreferenceRequest\{EventType: eventType, OptedIn: false\}\)\s*\n\}/,
    );
    expect(body).toMatch(/\/\/ OptIn is a convenience wrapper for Set with opted_in=true\./);
    expect(body).toMatch(
      /func \(r \*EmailPreferencesResource\) OptIn\(ctx context\.Context, eventType string\) error \{\s*\n\s*return r\.Set\(ctx, &SetEmailPreferenceRequest\{EventType: eventType, OptedIn: true\}\)\s*\n\}/,
    );
    // The previous (wrong) (*EmailPreference, error) signature must
    // NOT return on either method.
    expect(body).not.toMatch(
      /func \(r \*EmailPreferencesResource\) OptOut\([^)]+\) \(\*EmailPreference, error\)/,
    );
    expect(body).not.toMatch(
      /func \(r \*EmailPreferencesResource\) OptIn\([^)]+\) \(\*EmailPreference, error\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
