// W580.C (W655-deepened) — drift guard for packages/sdk-python/src/
// driftstack/resources/email_preferences.py. V-204/V-449 email-
// preferences Python parity.
//
// W655 splits the original 5 it() blocks into 12 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • Critical-emails-not-opt-outable invariant — the 3 event types
//     that cannot be opted out of (verification + password-reset +
//     billing-failure; S44 2026-07-07 trimmed the never-wired
//     subscription-cancellation + support-ack templates)
//     pinned per-line. Drift to letting any of these into the
//     OptOutableEmailEvent enum would let customers silently opt
//     out of receiving "your password was reset" or "your card
//     failed", catastrophically breaking the safety net.
//   • Opt-in-by-default invariant pinned: "Defaults opted-in for
//     unset rows." Drift to opt-out-by-default would silently
//     mute every customer's non-critical emails (newsletter,
//     product updates, weekly digest) — they'd never know they
//     stopped receiving things.
//   • set body 2-field shape pinned: {"event_type": "...",
//     "opted_in": True|False}. PUT verb (not PATCH) because the
//     write replaces the entire row for one event_type, not
//     partial-update of multiple fields.
//   • opt_in/opt_out convenience wrappers pinned per-method —
//     each delegates to .set({"event_type": event_type, "opted_in":
//     False|True}). Drift to opt_in calling set with opted_in=False
//     would invert the semantic of the convenience wrapper.
//   • Sync/async parallel surface — 4-verb count exact across both
//     classes via regex count.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/email_preferences.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W580.C packages/sdk-python/src/driftstack/resources/email_preferences.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module docstring V-204/V-449 anchor + "Per-event opt-in/opt-out toggles for non-critical customer emails" scope (load-bearing: this is the customer-controlled OPT-OUT surface, not admin-side suppression list)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /^"""Email preferences resource — \/v1\/account\/email-preferences \(V-204 \/ V-449\)\.\n/,
    );
    expect(body).toMatch(/Per-event opt-in\/opt-out toggles for non-critical customer emails\./);
  });

  it('CRITICAL: critical-emails-not-opt-outable invariant pinned per-line. The 3 critical event types (verification / password-reset / billing-failure) MUST NOT be opt-outable. Drift to letting any of these into OptOutableEmailEvent would silently let customers opt out of "your password was reset" or "your card failed" — catastrophic safety-net break. The enum-naming invariant ("not in the OptOutableEmailEvent enum on purpose") is what enforces this at compile-time on the server side. (S44 2026-07-07 founder-approved trim deleted the never-wired subscription-cancellation + support-ack templates — roster 5→3.)', () => {
    expect(body).toMatch(
      /Critical emails \(verification \/ password-reset \/ billing-failure\)\s*\nare not opt-outable; they aren't in the OptOutableEmailEvent enum on purpose\./,
    );
    // S44 negative pins — the deleted templates must not resurface.
    expect(body).not.toMatch(/subscription-cancellation/);
    expect(body).not.toMatch(/support-ack/);
  });

  it('Imports — __future__ annotations + typing Any + 2-class HTTP client + coerce_body helper. coerce_body is load-bearing because the set() body has a typed shape (event_type + opted_in bool) and customers may pass it as either a dict or a future EmailPreferenceUpdateRequest pydantic model.', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('EmailPreferencesResource (sync) class declaration + __init__(http: HttpClient). Stateless wrapper.', () => {
    expect(body).toMatch(/^class EmailPreferencesResource:$/m);
    expect(body).toMatch(/^ {4}"""Synchronous email-preferences resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
  });

  it('Sync list — GET /v1/account/email-preferences. CRITICAL: "Defaults opted-in for unset rows." Drift to opt-out-by-default would silently mute every customer\'s non-critical emails (newsletter / product updates / weekly digest) — they\'d never know they stopped receiving things. This is the load-bearing claim that justifies opt-out rows existing on the row (not absence-of-row).', () => {
    expect(body).toMatch(
      /def list\(self\) -> dict\[str, Any\]:\s*\n\s*"""Read all opt-out toggles\. Defaults opted-in for unset rows\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/email-preferences"\)/,
    );
  });

  it('Sync set — PUT /v1/account/email-preferences. CRITICAL: PUT (not PATCH) because the write replaces the entire row for one event_type, not partial-update across multiple fields. Body shape pinned: {"event_type": "...", "opted_in": True|False} — exactly 2 fields. The return-type is None — the server replies 204 No Content; the previous pin asserted `-> dict[str, Any]` which was source-of-truth-divergent (customer code would assign None to a typed-dict var). Customers needing the post-update state call list().', () => {
    expect(body).toMatch(/def set\(self, body: dict\[str, Any\]\) -> None:/);
    expect(body).toMatch(
      /Set opt-in\/opt-out for a single event type\.\s*\n\s*\n\s*``body``: ``\{"event_type": "\.\.\.", "opted_in": True\|False\}``\s*\n\s*\n\s*Returns ``None`` — the server replies ``204 No Content``/,
    );
    expect(body).toMatch(
      /self\._http\.request\(\s*\n\s*"PUT", "\/v1\/account\/email-preferences", json_body=coerce_body\(body\)\s*\n\s*\)/,
    );
    // The previous (wrong) -> dict[str, Any] return must NOT return.
    expect(body).not.toMatch(/def set\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
  });

  it('Sync opt_out — convenience wrapper that delegates to self.set({"event_type": event_type, "opted_in": False}). Returns None matching set(). The function-rename invariant matters: opt_out MUST keep opted_in=False semantics stable.', () => {
    expect(body).toMatch(
      /def opt_out\(self, event_type: str\) -> None:\s*\n\s*"""Convenience: opt out of a single event type\."""\s*\n\s*self\.set\(\{"event_type": event_type, "opted_in": False\}\)/,
    );
  });

  it('Sync opt_in — convenience wrapper that delegates to self.set({"event_type": event_type, "opted_in": True}). Mirror of opt_out with opted_in=True. Returns None matching set(). "Opt back in" framing acknowledges this is the un-undo of a prior opt_out.', () => {
    expect(body).toMatch(
      /def opt_in\(self, event_type: str\) -> None:\s*\n\s*"""Convenience: opt back in to a single event type\."""\s*\n\s*self\.set\(\{"event_type": event_type, "opted_in": True\}\)/,
    );
  });

  it('AsyncEmailPreferencesResource — class declaration + __init__(http: AsyncHttpClient). Mirrors sync class structure exactly.', () => {
    expect(body).toMatch(/^class AsyncEmailPreferencesResource:$/m);
    expect(body).toMatch(/^ {4}"""Async email-preferences resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
  });

  it('Async list + set — awaited GET/PUT twins with same wire paths + same coerce_body wrapping on set. Async set returns None matching the sync side (the wire replies 204 No Content).', () => {
    expect(body).toMatch(
      /async def list\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/email-preferences"\)/,
    );
    expect(body).toMatch(
      /async def set\(self, body: dict\[str, Any\]\) -> None:[\s\S]+?await self\._http\.request\(\s*\n\s*"PUT", "\/v1\/account\/email-preferences", json_body=coerce_body\(body\)\s*\n\s*\)/,
    );
  });

  it('Async opt_out + opt_in — convenience wrappers `await self.set({event_type, opted_in})`. Returns None matching sync. Same delegated-False / delegated-True semantic.', () => {
    expect(body).toMatch(
      /async def opt_out\(self, event_type: str\) -> None:\s*\n\s*await self\.set\(\{"event_type": event_type, "opted_in": False\}\)/,
    );
    expect(body).toMatch(
      /async def opt_in\(self, event_type: str\) -> None:\s*\n\s*await self\.set\(\{"event_type": event_type, "opted_in": True\}\)/,
    );
  });

  it('4-verb inventory drift guard — sync defines exactly 5 method defs (4 verbs + __init__); async defines the same 5. Verb-mix: 2 GETs (list × sync+async), 2 PUTs (set × sync+async), 0 POSTs/PATCHes/DELETEs (opt_in/opt_out are DELEGATIONS to set, not separate wire verbs — they MUST NOT mint their own wire calls). Drift to opt_in calling http.request directly would silently double the wire-call count.', () => {
    const syncStart = body.indexOf('class EmailPreferencesResource:');
    const asyncStart = body.indexOf('class AsyncEmailPreferencesResource:');
    expect(syncStart, 'expected sync class to come first').toBeGreaterThan(0);
    expect(asyncStart, 'expected async class to come after sync class').toBeGreaterThan(syncStart);
    const syncBody = body.slice(syncStart, asyncStart);
    const asyncBody = body.slice(asyncStart);
    const syncDefs = (syncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(syncDefs, 'expected 5 sync method defs (4 verbs + __init__)').toBe(5);
    const asyncDefs = (asyncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(asyncDefs, 'expected 5 async method defs (4 verbs + __init__)').toBe(5);
    // Exactly 2 GETs (list × 2) + 2 PUTs (set × 2). NO POST/PATCH/DELETE.
    const gets = (body.match(/"GET", "\/v1\/account\/email-preferences"/g) ?? []).length;
    expect(gets, 'expected 2 GETs').toBe(2);
    const puts = (body.match(/"PUT", "\/v1\/account\/email-preferences"/g) ?? []).length;
    expect(puts, 'expected 2 PUTs').toBe(2);
    expect(body).not.toMatch(/"POST", "\/v1\/account\/email-preferences/);
    expect(body).not.toMatch(/"PATCH", "\/v1\/account\/email-preferences/);
    expect(body).not.toMatch(/"DELETE", "\/v1\/account\/email-preferences/);
  });
});
