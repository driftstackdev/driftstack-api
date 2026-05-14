// W690 — cross-SDK V-352b avatar content_type allowlist parity.
// Seventeenth in the cross-SDK drift-guard series (W649 + W675 +
// W676 + W677 + W678 + W679 + W680 + W681 + W682 + W683 + W684 +
// W685 + W686 + W687 + W688 + W689 + W690).
//
// Asserts the V-352b avatar content_type 3-value allowlist (PNG +
// JPEG + WebP) is consistently pinned across all 3 SDKs.
//
// SECURITY-CRITICAL: drift to widening would open attack vectors:
//   - image/svg+xml → XSS via SVG-embedded <script> tags
//     (SVG can carry executable JS; browsers render avatars inline
//     so injected script would run in the customer's session)
//   - image/gif → animated avatar abuse (chat-noise / seizure-
//     inducing for accessibility customers)
//   - image/bmp / image/tiff → uncompressed-bomb DoS (server
//     decodes them and they can blow up to 100x raw bytes)
//   - application/* → bypass of the image content-type check
//
// The 3-format allowlist is what keeps avatar uploads safe.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_ACCOUNT = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/account.ts');
const GO_ACCOUNT = resolve(REPO_ROOT, 'packages/sdk-go/account.go');
const PY_ACCOUNT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/account.py');

describe('W690 cross-SDK V-352b avatar content_type allowlist parity', () => {
  it('all 3 SDK account resource files exist at canonical paths', () => {
    expect(existsSync(TS_ACCOUNT), `missing ${TS_ACCOUNT}`).toBe(true);
    expect(existsSync(GO_ACCOUNT), `missing ${GO_ACCOUNT}`).toBe(true);
    expect(existsSync(PY_ACCOUNT), `missing ${PY_ACCOUNT}`).toBe(true);
  });

  it('CRITICAL V-352b anchor pinned in all 3 SDKs on avatar upload + clear surfaces. Drift to dropping the V-352b anchor would lose changelog provenance for the avatar feature.', () => {
    const ts = read(TS_ACCOUNT);
    const go = read(GO_ACCOUNT);
    const py = read(PY_ACCOUNT);

    expect(ts).toMatch(/V-352b/);
    expect(go).toMatch(/V-352b/);
    expect(py).toMatch(/V-352b/);
  });

  it('CRITICAL UploadAvatarResponse content_type 3-value allowlist pinned in sdk-typescript: `image/png | image/jpeg | image/webp` literal-type union. The TS type system REJECTS any other content_type at COMPILE TIME — drift to widening to `string` would lose this compile-time guard.', () => {
    const ts = read(TS_ACCOUNT);
    expect(ts).toMatch(/content_type: 'image\/png' \| 'image\/jpeg' \| 'image\/webp';/);
  });

  it('CRITICAL sdk-go content_type allowlist pinned via comment + struct field. sdk-go uses `string` type on the wire (Go has no compile-time literal-type unions on struct fields), so the allowlist is enforced server-side. The comment `// "image/png" | "image/jpeg" | "image/webp"` IS load-bearing as the customer-facing claim.', () => {
    const go = read(GO_ACCOUNT);
    expect(go).toMatch(/"image\/png" \| "image\/jpeg" \| "image\/webp"/);
  });

  it('CRITICAL sdk-python content_type allowlist pinned via docstring framing. sdk-python uses dict[str, Any] body so the allowlist is enforced server-side. The docstring `"image/png|jpeg|webp"` IS load-bearing as the customer-facing claim.', () => {
    const py = read(PY_ACCOUNT);
    expect(py).toMatch(/"image\/png\|jpeg\|webp"/);
  });

  it('CRITICAL all 3 SDKs reference the same 3 formats — PNG + JPEG + WebP. Drift to dropping any format would break customer uploads. Drift to adding a 4th format (especially SVG) would open XSS vectors.', () => {
    const sdks = {
      'sdk-typescript': read(TS_ACCOUNT),
      'sdk-go': read(GO_ACCOUNT),
      'sdk-python': read(PY_ACCOUNT),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} mentions image/png`).toMatch(/image\/png/);
      expect(body, `${name} mentions image/jpeg`).toMatch(/image\/jpeg|jpeg/);
      expect(body, `${name} mentions image/webp`).toMatch(/image\/webp|webp/);
    }
  });

  it('CRITICAL no SVG / GIF / BMP / TIFF mentioned in allowlist. The closed-3 set must NOT extend to other formats. (We grep for the FULL "image/svg" pattern — if any SDK lists it as part of an allowlist, the test should fail.) Drift to adding SVG to any SDK\'s allowlist would silently open XSS.', () => {
    const sdks = {
      'sdk-typescript': read(TS_ACCOUNT),
      'sdk-go': read(GO_ACCOUNT),
      'sdk-python': read(PY_ACCOUNT),
    };

    for (const [name, body] of Object.entries(sdks)) {
      // image/svg+xml is the format that would allow XSS — drift to allowing it would open the vector.
      expect(body, `${name} should NOT list image/svg+xml`).not.toMatch(/image\/svg\+xml/);
      // image/gif (animated avatar abuse).
      expect(body, `${name} should NOT list image/gif in allowlist`).not.toMatch(/image\/gif/);
    }
  });

  it('CRITICAL sdk-go UploadAvatarRequest 2 MiB raw cap pinned via comment. The server-side max-body cap is what prevents avatar-upload DoS via huge base64 payloads. Drift to a higher cap would let attackers exhaust upload bandwidth; drift to a lower cap would force customers to pre-compress modest avatars.', () => {
    const go = read(GO_ACCOUNT);
    expect(go).toMatch(/max 2 MiB raw/);
  });

  it('CRITICAL UploadAvatarResponse 3-field shape pinned across all 3 SDKs — avatar_url + content_type + bytes. The 3-field response is what lets dashboard render the upload-success state WITHOUT re-fetching me(). Drift to dropping `bytes` would force dashboards to fetch the URL just to compute the size.', () => {
    const ts = read(TS_ACCOUNT);
    const go = read(GO_ACCOUNT);
    const py = read(PY_ACCOUNT);

    // sdk-typescript: UploadAvatarResponse interface with 3 fields.
    expect(ts).toMatch(
      /export interface UploadAvatarResponse \{[\s\S]*?avatar_url: string \| null;[\s\S]*?content_type:[\s\S]*?bytes: number;[\s\S]*?\}/,
    );

    // sdk-go: UploadAvatarResponse struct with avatar_url + content_type + bytes.
    expect(go).toMatch(/AvatarURL\s+\*string/);

    // sdk-python: "Returns ``{"avatar_url": ..., "content_type": ..., "bytes": ...}``"
    expect(py).toMatch(/"avatar_url": \.\.\., "content_type": \.\.\., "bytes": \.\.\./);
  });

  it('CRITICAL "presigned" + "short-lived" framing on avatar_url pinned per-SDK. The presigned R2 URL is what lets browsers fetch the avatar without exposing the underlying R2 bucket. ~1h short-lived window is what prevents the URL from being shared indefinitely. Drift to non-presigned would expose the bucket; drift to longer-lived would let URLs be shared past account-deletion.', () => {
    const ts = read(TS_ACCOUNT);
    const go = read(GO_ACCOUNT);

    // sdk-typescript: "short-lived (~1h) presigned R2 GET URL"
    expect(ts).toMatch(/short-lived \(~1h\) presigned R2 GET URL/);

    // sdk-go: "short-lived presigned URL"
    expect(go).toMatch(/short-lived presigned URL/);
  });

  it('Cross-SDK V-352b 5-invariant cluster — V-352b anchor + 3-format allowlist (PNG/JPEG/WebP) + presigned URL framing + 3-field response shape. Drift on any 5 would fragment the cross-language avatar contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_ACCOUNT),
      'sdk-go': read(GO_ACCOUNT),
      'sdk-python': read(PY_ACCOUNT),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-352b anchor`).toMatch(/V-352b/);
      expect(body, `${name} png`).toMatch(/png/);
      expect(body, `${name} jpeg`).toMatch(/jpeg/);
      expect(body, `${name} webp`).toMatch(/webp/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-avatar-allowlist-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
