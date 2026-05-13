// W581.C — drift guard for packages/sdk-python/src/resources/account.py.
// V-385/V-428/V-434/V-450 AccountResource Python parity. Drift here
// either drops a V-450 self-service verb (update_me / avatar /
// web-sessions / rate-limits) or breaks the X-Driftstack-Account
// team-RBAC-immunity invariant on `me`.
//
//   • Module docstring frames V-385/V-428/V-434/V-450 + V-450
//     update-me/avatar/web-sessions/rate-limits extension.
//   • 8 verbs each: me + update_me + upload_avatar + clear_avatar +
//     list_web_sessions + revoke_web_session + revoke_all_other_web_
//     sessions + rate_limits.
//   • me() returns 15+ fields including V-352/V-298a/V-298b/V-352b/
//     V-353h/V-326c surfaces; never honors X-Driftstack-Account.
//   • V-355 web-session revoke is idempotent + quote()-escapes id.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/account.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W581.C packages/sdk-python/src/driftstack/resources/account.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + V-385/V-428/V-434/V-450 framing + V-450 update-me/avatar/web-sessions/rate-limits extension + dict[str, Any]-pending-regen pinned', () => {
    expect(body).toMatch(
      /^"""Account resource — \/v1\/account\/\* \(V-385 \/ V-428 \/ V-434 \/ V-450\)\.\n/,
    );
    expect(body).toMatch(/V-450 extends to cover update-me, avatar upload\+clear, web-sessions/);
    expect(body).toMatch(/list\+revoke, and rate-limits read\./);
    expect(body).toMatch(/Type annotations on the response use ``dict\[str, Any\]`` pending the/);
    expect(body).toMatch(/next ``scripts\/generate\.sh`` regen pass\./);
  });

  it('Imports: __future__ + Any + urllib.parse quote + AsyncHttpClient/HttpClient + coerce_body helper pinned', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import quote$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('Sync AccountResource: me() pinned with 15+ field catalogue + X-Driftstack-Account team-RBAC-immune framing (always returns caller account) + V-352/V-298a/V-298b/V-352b/V-353h/V-326c surfaces', () => {
    expect(body).toMatch(/^class AccountResource:$/m);
    expect(body).toMatch(/def me\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Read the calling account's full self-visible state\./);
    expect(body).toMatch(/Returns 15\+ fields incl\. ``id``, ``email``, ``name``, ``tier``,/);
    expect(body).toMatch(/``status``, ``timezone`` \(V-352\), ``slug`` \(V-298a\),/);
    expect(body).toMatch(/``region`` \(V-298b\), ``avatar_url`` \(V-352b\),/);
    expect(body).toMatch(/``mfa_enrolled`` \(V-353h\), ``concurrent_session_cap`` \//);
    expect(body).toMatch(/``concurrent_session_active`` \/ ``profile_cap`` \//);
    expect(body).toMatch(/``profile_count``, and ``teams`` \(V-326c\)\./);
    expect(body).toMatch(/Bearer-authenticated; never honors the X-Driftstack-Account/);
    expect(body).toMatch(/team-RBAC header \(always returns the caller's own account\)\./);
    expect(body).toMatch(/return self\._http\.request\("GET", "\/v1\/account\/me"\)/);
  });

  it('Sync update_me + avatar verbs: PATCH /me partial-update (timezone/slug/region nullable; >=1 field) + POST /me/avatar data_base64+content_type + DELETE /me/avatar idempotent clear', () => {
    expect(body).toMatch(/def update_me\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-352 — partial update of the calling account/);
    expect(body).toMatch(/\(name \/ timezone \/ slug \/ region\)\. Pass ``null`` to clear a/);
    expect(body).toMatch(/nullable field; at least one field required\./);
    expect(body).toMatch(
      /return self\._http\.request\("PATCH", "\/v1\/account\/me", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/def upload_avatar\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-352b — upload \(or replace\) the calling account avatar\./);
    expect(body).toMatch(
      /Body: ``\{"data_base64": "\.\.\.", "content_type": "image\/png\|jpeg\|webp"\}``\./,
    );
    expect(body).toMatch(
      /Returns ``\{"avatar_url": \.\.\., "content_type": \.\.\., "bytes": \.\.\.\}``\./,
    );
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/account\/me\/avatar", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /def clear_avatar\(self\) -> None:\s*\n\s*"""V-352b — clear the avatar pointer\."""\s*\n\s*self\._http\.request\("DELETE", "\/v1\/account\/me\/avatar"\)/,
    );
  });

  it('Sync V-355 web-session verbs + V-258 rate-limits: list-with-current-flag + revoke-single-quote-escaped + revoke-all-other (DELETE collection root) + rate_limits read', () => {
    expect(body).toMatch(
      /def list_web_sessions\(self\) -> dict\[str, Any\]:\s*\n\s*"""V-355 — list active dashboard sign-ins\. The calling\s*\n\s*session is marked with ``current: true``\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/web-sessions"\)/,
    );
    expect(body).toMatch(/def revoke_web_session\(self, session_id: str\) -> None:/);
    expect(body).toMatch(/"""V-355 — revoke a single web session by id\. Idempotent\."""/);
    expect(body).toMatch(
      /self\._http\.request\("DELETE", f"\/v1\/account\/web-sessions\/\{quote\(session_id, safe=''\)\}"\)/,
    );
    expect(body).toMatch(
      /def revoke_all_other_web_sessions\(self\) -> None:\s*\n\s*"""V-355 — revoke every web session except the calling one\."""\s*\n\s*self\._http\.request\("DELETE", "\/v1\/account\/web-sessions"\)/,
    );
    expect(body).toMatch(
      /def rate_limits\(self\) -> dict\[str, Any\]:\s*\n\s*"""V-258 — read effective rate-limit config\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/rate-limits"\)/,
    );
  });

  it('Async AsyncAccountResource: mirrored awaited 8-verb surface', () => {
    expect(body).toMatch(/^class AsyncAccountResource:$/m);
    expect(body).toMatch(
      /async def me\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/me"\)/,
    );
    expect(body).toMatch(
      /async def update_me\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("PATCH", "\/v1\/account\/me", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /async def upload_avatar\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /async def clear_avatar\(self\) -> None:\s*\n\s*await self\._http\.request\("DELETE", "\/v1\/account\/me\/avatar"\)/,
    );
    expect(body).toMatch(
      /async def revoke_web_session\(self, session_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", f"\/v1\/account\/web-sessions\/\{quote\(session_id, safe=''\)\}"\)/,
    );
    expect(body).toMatch(
      /async def revoke_all_other_web_sessions\(self\) -> None:\s*\n\s*await self\._http\.request\("DELETE", "\/v1\/account\/web-sessions"\)/,
    );
    expect(body).toMatch(
      /async def rate_limits\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/rate-limits"\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
