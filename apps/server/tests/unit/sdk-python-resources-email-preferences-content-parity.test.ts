// W580.C — drift guard for packages/sdk-python/src/resources/email_preferences.py.
// V-204/V-449 EmailPreferencesResource Python parity. Drift here
// either flips opt-in-by-default semantics for unset rows, drops
// the convenience opt_in/opt_out shortcuts, or accidentally adds
// a critical-email event_type to the opt-outable surface.
//
//   • Two paired classes: EmailPreferencesResource (sync) +
//     AsyncEmailPreferencesResource.
//   • Critical emails (verification / password-reset / billing-
//     failure / subscription-cancellation / support-ack) are NOT
//     opt-outable — not in OptOutableEmailEvent enum on purpose.
//   • 4 verbs each: list / set / opt_out / opt_in.
//   • set body shape: {"event_type": "...", "opted_in": True|False}.
//   • opt_out + opt_in are convenience wrappers that delegate to set.

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

  it('Module docstring + V-204/V-449 framing + per-event opt-in/opt-out + critical-emails-not-opt-outable rationale pinned', () => {
    expect(body).toMatch(
      /^"""Email preferences resource — \/v1\/account\/email-preferences \(V-204 \/ V-449\)\.\n/,
    );
    expect(body).toMatch(/Per-event opt-in\/opt-out toggles for non-critical customer emails\./);
    expect(body).toMatch(/Critical emails \(verification \/ password-reset \/ billing-failure \//);
    expect(body).toMatch(/subscription-cancellation \/ support-ack\) are not opt-outable; they/);
    expect(body).toMatch(/aren't in the OptOutableEmailEvent enum on purpose\./);
  });

  it('Imports: __future__ + Any + AsyncHttpClient/HttpClient + coerce_body helper pinned', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('Sync EmailPreferencesResource: 4 verbs (list GET + set PUT + opt_out + opt_in) + opt_out/opt_in delegate to set with opted_in=False/True', () => {
    expect(body).toMatch(/^class EmailPreferencesResource:$/m);
    expect(body).toMatch(/"""Synchronous email-preferences resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
    expect(body).toMatch(
      /def list\(self\) -> dict\[str, Any\]:\s*\n\s*"""Read all opt-out toggles\. Defaults opted-in for unset rows\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/email-preferences"\)/,
    );
    expect(body).toMatch(/def set\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Set opt-in\/opt-out for a single event type\./);
    expect(body).toMatch(/``body``: ``\{"event_type": "\.\.\.", "opted_in": True\|False\}``/);
    expect(body).toMatch(
      /return self\._http\.request\(\s*\n\s*"PUT", "\/v1\/account\/email-preferences", json_body=coerce_body\(body\)\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /def opt_out\(self, event_type: str\) -> dict\[str, Any\]:\s*\n\s*"""Convenience: opt out of a single event type\."""\s*\n\s*return self\.set\(\{"event_type": event_type, "opted_in": False\}\)/,
    );
    expect(body).toMatch(
      /def opt_in\(self, event_type: str\) -> dict\[str, Any\]:\s*\n\s*"""Convenience: opt back in to a single event type\."""\s*\n\s*return self\.set\(\{"event_type": event_type, "opted_in": True\}\)/,
    );
  });

  it('Async AsyncEmailPreferencesResource: mirrored awaited 4-verb surface; opt_out/opt_in await self.set', () => {
    expect(body).toMatch(/^class AsyncEmailPreferencesResource:$/m);
    expect(body).toMatch(/"""Async email-preferences resource\."""/);
    expect(body).toMatch(
      /async def list\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/email-preferences"\)/,
    );
    expect(body).toMatch(
      /async def set\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"PUT", "\/v1\/account\/email-preferences", json_body=coerce_body\(body\)\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /async def opt_out\(self, event_type: str\) -> dict\[str, Any\]:\s*\n\s*return await self\.set\(\{"event_type": event_type, "opted_in": False\}\)/,
    );
    expect(body).toMatch(
      /async def opt_in\(self, event_type: str\) -> dict\[str, Any\]:\s*\n\s*return await self\.set\(\{"event_type": event_type, "opted_in": True\}\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
