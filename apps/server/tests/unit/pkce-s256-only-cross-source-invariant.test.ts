// Cross-source invariant: PKCE uses S256 method exclusively across
// the OAuth Authorization Server (lib/oauth-pkce + routes/oauth) AND
// the OAuth client flow (lib/oauth-client-providers). The `plain`
// challenge method is rejected. Drift to allowing `plain` anywhere
// in the stack would weaken the PKCE security model — the whole
// point of PKCE is that the verifier reaches the server only
// via a one-way-hashed challenge.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PKCE = resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts');
const PROVIDERS = resolve(REPO_ROOT, 'apps/server/src/lib/oauth-client-providers.ts');
const DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages/api/oauth.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('PKCE S256-only cross-source invariant', () => {
  const pkce = read(PKCE);
  const providers = read(PROVIDERS);
  const docs = read(DOCS);

  it("lib/oauth-pkce documents the S256 method flow: 'PKCE flow recap (S256 method)' + 'code_challenge=<challenge>&code_challenge_method=S256' + 'Driftstack recomputes sha256 and compares.' — pinned so the canonical PKCE-S256 contract stays documented", () => {
    expect(pkce).toMatch(/\/\/ PKCE flow recap \(S256 method\):/);
    expect(pkce).toMatch(/code_challenge=<challenge>&code_challenge_method=S256/);
    expect(pkce).toMatch(/Driftstack recomputes sha256 and compares\./);
  });

  it("lib/oauth-pkce computeS256Challenge implementation pinned: 'challenge = base64url(sha256(verifier))' formula + computeS256Challenge function — pinned so the S256-challenge derivation stays in sync with RFC 7636 §4.2", () => {
    expect(pkce).toMatch(
      /\*\s+Compute the S256 challenge for a given verifier:\s*\*\s+challenge = base64url\(sha256\(verifier\)\)/,
    );
    expect(pkce).toMatch(/export function computeS256Challenge\(verifier: string\): string \{/);
  });

  it("lib/oauth-client-providers buildAuthorizeUrl sends code_challenge_method: 'S256' — pinned so the OAuth-CLIENT outbound authorize URL carries S256 (drift to 'plain' would let the IDP accept an unwrapped verifier echo + weaken the PKCE benefit on the inbound client flow)", () => {
    expect(providers).toMatch(/code_challenge_method: 'S256',/);
  });

  it("docs/api/oauth.md explicitly forbids 'plain' challenge method: 'The plain challenge method is rejected — S256 only.' — pinned so the customer-facing S256-only contract stays documented (drift to silently allowing plain would be a security regression)", () => {
    expect(docs).toMatch(/The\s*`plain` challenge method is rejected — `S256` only\./);
  });

  it("docs/api/oauth.md commits to RFC 7636 + 'PKCE required (RFC 7636 — no exceptions, even for confidential clients)' — pinned so the no-exceptions-for-confidential-clients commitment stays documented", () => {
    expect(docs).toMatch(
      /\*\*PKCE required\*\* \(RFC 7636 — no exceptions, even for confidential\s*clients\)/,
    );
  });
});
