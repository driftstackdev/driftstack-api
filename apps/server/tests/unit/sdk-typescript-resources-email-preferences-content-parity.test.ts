// W429.A (W656-deepened) — drift guard for packages/sdk-typescript/
// src/resources/email-preferences.ts. V-204 EmailPreferencesResource
// TS parity.
//
// W656 splits the original 8 it() blocks into 14 focused per-concept
// blocks + pins previously-implicit invariants. Mirrors the W655
// sdk-python email-preferences split:
//
//   • Critical-emails-never-opt-outable invariant pinned per-line.
//     The 3 critical emails (signup-verification + password-reset +
//     billing-failure; S44 2026-07-07 trimmed the never-wired
//     subscription-cancellation + support-ack templates)
//     MUST be absent from the OptOutableEmailEvent enum so the TS
//     type system REJECTS `optOut('password-reset')` at compile
//     time (the function parameter is typed
//     `OptOutableEmailEvent` not `string`). Type-narrowing is what
//     enforces the policy at the client side; the server enforces
//     it again at runtime.
//   • Opt-in-by-default invariant pinned: "Defaults to opted-in
//     for unset rows."
//   • PUT (not POST) — idempotent upsert per event_type. Drift to
//     POST would duplicate rows on retry.
//   • Examples of opt-outable emails pinned (signup-welcome /
//     session-failed-first / billing-receipt) — load-bearing
//     because they document the policy scope.
//   • optIn/optOut convenience wrappers delegate to set() with the
//     correct boolean. Drift to optIn calling set with opted_in:
//     false would invert the wrapper semantic.
//   • 4-verb inventory drift guard via regex count.

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

  it('file exists at canonical path + module header V-204 anchor on the resource line', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ EmailPreferencesResource — typed methods for \/v1\/account\/email-preferences \(V-204\)\./,
    );
  });

  it('Per-event opt-in/opt-out scope pinned with example opt-outable event names (signup-welcome / session-failed-first / billing-receipt). Load-bearing because these examples document the policy scope — readers should be able to look at the comment and understand which kinds of emails CAN be muted.', () => {
    expect(body).toMatch(
      /\/\/ Per-event opt-in\/opt-out toggles for non-critical customer emails\s*\n?\s*\/\/ \(signup-welcome, session-failed-first, billing-receipt, etc\)\./,
    );
  });

  it('CRITICAL: critical-emails-never-opt-outable invariant pinned per-line. The 3 critical emails (signup-verification + password-reset + billing-failure) MUST be absent from OptOutableEmailEvent enum. This is the policy-enforcement claim: "absent from the OptOutableEmailEvent enum on purpose so the API surface matches the policy." Drift to letting a critical email into the enum would let customers opt out of "your password was reset" or "your card failed" — catastrophic safety-net break. (S44 2026-07-07 founder-approved trim deleted the never-wired subscription-cancellation + support-ack templates, so the roster shrank 5→3; the deleted names must NOT reappear here as if they were live emails.)', () => {
    expect(body).toMatch(
      /\/\/ Critical emails — signup-verification, password-reset,\s*\n?\s*\/\/ billing-failure — are never opt-outable; they're absent from the\s*\n?\s*\/\/ OptOutableEmailEvent enum on purpose so the API surface matches\s*\n?\s*\/\/ the policy\./,
    );
    // S44 negative pins — the deleted templates must not resurface.
    expect(body).not.toMatch(/subscription-cancellation/);
    expect(body).not.toMatch(/support-ack/);
  });

  it('Imports — 3 api-types shapes (multi-line braced; sorted alphabetical): ListEmailPreferencesResponse + OptOutableEmailEvent + SetEmailPreferenceRequest. The OptOutableEmailEvent import is load-bearing — without it the optIn/optOut params would fall back to `string` and the type-narrowing safety net would be lost. EmailPreference type was dropped from the imports because the PUT route returns 204 No Content (no body); the SDK return type is now `Promise<void>` matching the wire shape.', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*ListEmailPreferencesResponse,\s*\n?\s*OptOutableEmailEvent,\s*\n?\s*SetEmailPreferenceRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    // EmailPreference must NOT be in the import list — its return-
    // value role on set/optIn/optOut was always wire-divergent.
    expect(body).not.toMatch(/import type \{\s*\n?\s*EmailPreference,/);
  });

  it("Imports — HttpClient from '../http.js' (relative path with .js extension for ESM compatibility). Drift to dropping the .js extension would break the ESM build because TypeScript needs the literal .js suffix at runtime.", () => {
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('EmailPreferencesResource class declaration — exported. Stateless wrapper pattern shared with every other TS SDK resource.', () => {
    expect(body).toMatch(/^export class EmailPreferencesResource \{$/m);
  });

  it('Constructor — private-readonly http field. Drift to public-readonly would let customers tamper with the underlying HTTP client mid-call; drift to private (no readonly) would let internal reassignment happen which would silently lose retry config.', () => {
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('list verb — GET /v1/account/email-preferences. JSDoc: "Read all opt-out toggles for the EFFECTIVE account. Defaults to opted-in for unset rows." CRITICAL: "Defaults to opted-in for unset rows" — drift to opt-out-by-default would silently mute every customer\'s non-critical emails.', () => {
    expect(body).toMatch(
      /\/\*\* Read all opt-out toggles for the EFFECTIVE account\. Defaults to opted-in for unset rows\. \*\//,
    );
    expect(body).toMatch(
      /list\(\): Promise<ListEmailPreferencesResponse> \{\s*\n?\s*return this\.http\.request<ListEmailPreferencesResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/email-preferences',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('set verb — PUT /v1/account/email-preferences with SetEmailPreferenceRequest body. CRITICAL: PUT (not POST) because preference rows are UNIQUE per event_type — re-setting the same row is idempotent upsert, not a duplicate. Drift to POST would duplicate rows on retry, breaking the single-row-per-event-type invariant. Returns `Promise<void>` because the server replies 204 No Content — the previous pin asserted `Promise<EmailPreference>` which was source-of-truth-divergent (customer code awaiting set() would get undefined at runtime under a type that promised the EmailPreference shape).', () => {
    expect(body).toMatch(
      /Set opt-in\/opt-out for a single email event type\. The server\s*\n?\s+\* returns `204 No Content` on success/,
    );
    expect(body).toMatch(
      /set\(body: SetEmailPreferenceRequest\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'PUT',\s*\n?\s*path: '\/v1\/account\/email-preferences',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("optOut convenience — delegates to set({event_type: eventType, opted_in: false}). CRITICAL TYPE-SAFETY: eventType is typed `OptOutableEmailEvent`, NOT `string`. The TS type system rejects `optOut('password-reset')` at COMPILE TIME because \"password-reset\" isn't in the OptOutableEmailEvent enum. Returns `Promise<void>` mirroring set().", () => {
    expect(body).toMatch(/\/\*\* Convenience: opt out of a single event type\. \*\//);
    expect(body).toMatch(
      /optOut\(eventType: OptOutableEmailEvent\): Promise<void> \{\s*\n?\s*return this\.set\(\{ event_type: eventType, opted_in: false \}\);\s*\n?\s*\}/,
    );
  });

  it('optIn convenience — delegates to set({event_type: eventType, opted_in: true}). Mirror of optOut with opted_in:true. Same OptOutableEmailEvent type-narrowing on the parameter. Returns `Promise<void>` mirroring set().', () => {
    expect(body).toMatch(/\/\*\* Convenience: opt back in to a single event type\. \*\//);
    expect(body).toMatch(
      /optIn\(eventType: OptOutableEmailEvent\): Promise<void> \{\s*\n?\s*return this\.set\(\{ event_type: eventType, opted_in: true \}\);\s*\n?\s*\}/,
    );
  });

  it('4-verb inventory drift guard — exactly 4 method declarations (list + set + optOut + optIn) NO __init__ counted because TS uses constructor. Drift to a 5th method without test coverage would let an untested code path ship.', () => {
    // Count method declarations: `xxx(...args): ReturnType {`. The
    // constructor is excluded by anchoring on Promise< return type.
    const methods = body.match(/^ {2}[a-zA-Z]+\([^)]*\): Promise</gm) ?? [];
    expect(methods.length, 'expected exactly 4 method declarations').toBe(4);
  });

  it('Wire-call verb-mix invariant — exactly 1 GET (list) + 1 PUT (set) + 0 POST/PATCH/DELETE. optOut/optIn are DELEGATIONS to set, NOT separate wire calls — they MUST NOT mint their own this.http.request() calls. Drift to optIn calling http.request directly would silently double the wire-call count and break the upsert-uniqueness invariant.', () => {
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected exactly 1 GET (list)').toBe(1);
    const puts = (body.match(/method: 'PUT'/g) ?? []).length;
    expect(puts, 'expected exactly 1 PUT (set)').toBe(1);
    expect(body).not.toMatch(/method: 'POST'/);
    expect(body).not.toMatch(/method: 'PATCH'/);
    expect(body).not.toMatch(/method: 'DELETE'/);
    // optOut and optIn should both call this.set() — exactly 2 delegations.
    const setDelegations = (body.match(/return this\.set\(/g) ?? []).length;
    expect(setDelegations, 'expected exactly 2 this.set() delegations (optOut + optIn)').toBe(2);
  });

  it('Sync wire-path inventory pinned: only /v1/account/email-preferences appears in this file (1 base path, used by list GET + set PUT). Drift to a per-id sub-path (e.g. /v1/account/email-preferences/:event_type) would change the row-addressing model from event_type-in-body to event_type-in-URL.', () => {
    const paths = body.match(/path: '\/v1\/account\/email-preferences[^']*'/g) ?? [];
    expect(paths.length, 'expected exactly 2 path: literals (list + set)').toBe(2);
    // Both literal paths are the bare /v1/account/email-preferences (no sub-path).
    for (const p of paths) {
      expect(p).toBe("path: '/v1/account/email-preferences'");
    }
  });
});
