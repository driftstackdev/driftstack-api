// Drift guard for packages/sdk-python/src/driftstack/resources/egress.py.
// Pins the egress surface: per-session attach + the saved-proxy library on
// the LIVE account-proxies API (/v1/account/me/proxies), sync + async mirror,
// + the write-only-secret contract. Cross-SDK uniformity with TS + Go.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/egress.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-python resources/egress content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('docstring documents the LIVE account-proxies API + write-only secrets; no stale 503-stub framing', () => {
    expect(body).toMatch(/\/v1\/account\/me\/proxies/);
    expect(body).toMatch(/the same backend the desktop app \+\s*dashboard use/);
    expect(body).toMatch(/write-only/);
    expect(body).not.toMatch(/returns 503 ``FeatureUnavailable``/);
  });

  it('Sync EgressResource 7-method surface: attach_to_session + get_session_proxy + list_proxies + create_proxy + update_proxy + delete_proxy + test_proxy', () => {
    expect(body).toMatch(/class EgressResource:/);
    expect(body).toMatch(
      /def attach_to_session\(self, session_id: str, config: dict\[str, Any\]\)/,
    );
    expect(body).toMatch(/def get_session_proxy\(self, session_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/def list_proxies\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/def create_proxy\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /def update_proxy\(self, proxy_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/def delete_proxy\(self, proxy_id: str\) -> None:/);
    expect(body).toMatch(/def test_proxy\(self, proxy_id: str\) -> dict\[str, Any\]:/);
    expect(body).not.toMatch(/save_proxy|list_saved_proxies|delete_saved_proxy/);
  });

  it('Async AsyncEgressResource 7-method mirror pinned', () => {
    expect(body).toMatch(/class AsyncEgressResource:/);
    expect(body).toMatch(/async def attach_to_session\(/);
    expect(body).toMatch(/async def get_session_proxy\(/);
    expect(body).toMatch(/async def list_proxies\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/async def create_proxy\(/);
    expect(body).toMatch(/async def update_proxy\(/);
    expect(body).toMatch(/async def delete_proxy\(self, proxy_id: str\) -> None:/);
    expect(body).toMatch(/async def test_proxy\(/);
  });

  it('account-proxies routes pinned: /v1/account/me/proxies + /:id (quote-escaped) + /:id/test', () => {
    expect(body).toMatch(/"\/v1\/account\/me\/proxies"/);
    expect(body).toMatch(/f"\/v1\/account\/me\/proxies\/\{quote\(proxy_id, safe=''\)\}"/);
    expect(body).toMatch(/f"\/v1\/account\/me\/proxies\/\{quote\(proxy_id, safe=''\)\}\/test"/);
    expect(body).not.toMatch(/"\/v1\/proxies"/);
  });

  it("quote(...,safe='') on the session route + coerce_body() on create/update/attach bodies", () => {
    expect(body).toMatch(/f"\/v1\/sessions\/\{quote\(session_id, safe=''\)\}\/proxy"/);
    expect(body).toMatch(/json_body=coerce_body\(config\)/);
    expect(body).toMatch(/json_body=coerce_body\(body\)/);
  });
});
