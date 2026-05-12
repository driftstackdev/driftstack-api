// W429.A — drift guard for packages/sdk-typescript/src/resources/email-preferences.ts.
// V-204 EmailPreferencesResource — per-event opt-in/opt-out for
// non-critical customer emails. Drift here either lets critical
// emails leak into the OptOutableEmailEvent enum (regulatory risk —
// password-reset opt-out blocks security recovery) or breaks the
// PUT verb (set request becomes a no-op or duplicates rows).
//
//   • V-204 framing pinned + critical-emails-never-opt-outable list:
//     signup-verification, password-reset, billing-failure,
//     subscription-cancellation, support-ack.
//   • 4-verb surface: list (GET) + set (PUT) + optOut/optIn
//     convenience methods delegating to set.
//   • list defaults to opted-in for unset rows.
//   • set uses PUT (idempotent) NOT POST (preference rows are unique
//     per event_type).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/email-preferences.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W429.A packages/sdk-typescript/src/resources/email-preferences.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: V-204 typed methods for /v1/account/email-preferences + per-event opt-in/opt-out toggles for non-critical customer emails', () => {
    expect(body).toMatch(
      /\/\/ EmailPreferencesResource — typed methods for \/v1\/account\/email-preferences \(V-204\)\./,
    );
    expect(body).toMatch(
      /\/\/ Per-event opt-in\/opt-out toggles for non-critical customer emails\s*\n?\s*\/\/ \(signup-welcome, session-failed-first, billing-receipt, etc\)\./,
    );
  });

  it('Critical-emails-never-opt-outable policy pinned: signup-verification, password-reset, billing-failure, subscription-cancellation, support-ack absent from OptOutableEmailEvent enum on purpose', () => {
    expect(body).toMatch(
      /\/\/ Critical emails — signup-verification, password-reset,\s*\n?\s*\/\/ billing-failure, subscription-cancellation, support-ack — are\s*\n?\s*\/\/ never opt-outable; they're absent from the OptOutableEmailEvent\s*\n?\s*\/\/ enum on purpose so the API surface matches the policy\./,
    );
  });

  it('imports: EmailPreference + ListEmailPreferencesResponse + OptOutableEmailEvent + SetEmailPreferenceRequest from api-types + HttpClient', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*EmailPreference,\s*\n?\s*ListEmailPreferencesResponse,\s*\n?\s*OptOutableEmailEvent,\s*\n?\s*SetEmailPreferenceRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('list verb: GET /v1/account/email-preferences; defaults to opted-in for unset rows', () => {
    expect(body).toMatch(
      /\/\*\* Read all opt-out toggles for the calling account\. Defaults to opted-in for unset rows\. \*\//,
    );
    expect(body).toMatch(
      /list\(\): Promise<ListEmailPreferencesResponse> \{\s*\n?\s*return this\.http\.request<ListEmailPreferencesResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/email-preferences',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('set verb: PUT /v1/account/email-preferences (idempotent upsert, NOT POST); body SetEmailPreferenceRequest; returns EmailPreference row', () => {
    expect(body).toMatch(/\/\*\* Set opt-in\/opt-out for a single email event type\. \*\//);
    expect(body).toMatch(
      /set\(body: SetEmailPreferenceRequest\): Promise<EmailPreference> \{\s*\n?\s*return this\.http\.request<EmailPreference>\(\{\s*\n?\s*method: 'PUT',\s*\n?\s*path: '\/v1\/account\/email-preferences',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('optOut convenience: delegates to set with opted_in:false (single-event)', () => {
    expect(body).toMatch(/\/\*\* Convenience: opt out of a single event type\. \*\//);
    expect(body).toMatch(
      /optOut\(eventType: OptOutableEmailEvent\): Promise<EmailPreference> \{\s*\n?\s*return this\.set\(\{ event_type: eventType, opted_in: false \}\);\s*\n?\s*\}/,
    );
  });

  it('optIn convenience: delegates to set with opted_in:true (single-event re-opt-in)', () => {
    expect(body).toMatch(/\/\*\* Convenience: opt back in to a single event type\. \*\//);
    expect(body).toMatch(
      /optIn\(eventType: OptOutableEmailEvent\): Promise<EmailPreference> \{\s*\n?\s*return this\.set\(\{ event_type: eventType, opted_in: true \}\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
