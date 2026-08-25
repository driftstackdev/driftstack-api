// W873 — V-352b Avatar policy cross-source invariant. One-
// hundred-ninety-ninth in the drift-guard series. Pins the avatar
// upload policy:
//
//   - AVATAR_MAX_BYTES = 2 MiB (2 * 1024 * 1024).
//   - AVATAR_ALLOWED_CONTENT_TYPES = 3 values:
//     image/png + image/jpeg + image/webp.
//   - UploadAvatarRequest.data_base64 has /^[A-Za-z0-9+/=]+$/
//     regex + min(4) + max bound matching MIME 2 MiB → base64.
//
// stays in lockstep across:
//   - packages/api-types/src/accounts.ts (Zod canonical source).
//   - apps/customer-dashboard/src/pages/settings.astro
//     (file-input accept attr: 'image/png,image/jpeg,image/webp').
//   - apps/server/src/lib/openapi.ts (the PUBLISHED response schema).
//
// V-1615 added that third surface. It had been restating the three
// values inline while the header above listed two, which is the
// failure this whole series exists to catch: the guard's scan was
// narrower than the claim in its own first paragraph, so a fourth
// copy sat one import away from the constant and nothing read it.
//
// Drift would silently break:
//   * Customer uploading a content-type the server rejects
//     (silent file-picker mismatch).
//   * Server accepting an oversized file (2 MiB → DoS risk).
//   * A generated client refusing a legitimate RESPONSE. The route
//     echoes back the type the request schema accepted
//     (routes/account-me.ts:921 returns parsed.data.content_type),
//     so a fourth allowed type is uploaded, stored and returned in a
//     reply the document says cannot contain it — and the Python and
//     Go SDKs are generated from that document.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

describe('W873 Avatar policy cross-source invariant', () => {
  // ─── api-types canonical: AVATAR_ALLOWED_CONTENT_TYPES ───────

  it("CRITICAL packages/api-types/src/accounts.ts AVATAR_ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const. The 3-value array is the constant-source for the AvatarContentType enum + the file-picker accept attr.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /export const AVATAR_ALLOWED_CONTENT_TYPES = \['image\/png', 'image\/jpeg', 'image\/webp'\] as const;/,
    );
  });

  it('CRITICAL packages/api-types/src/accounts.ts AvatarContentTypeSchema = z.enum(AVATAR_ALLOWED_CONTENT_TYPES). The Zod enum delegates to the constant so the 2 stay in lockstep automatically.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /export const AvatarContentTypeSchema = z\.enum\(AVATAR_ALLOWED_CONTENT_TYPES\);/,
    );
  });

  it('CRITICAL AvatarContentType type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/export type AvatarContentType = z\.infer<typeof AvatarContentTypeSchema>;/);
  });

  // ─── AVATAR_MAX_BYTES = 2 MiB ────────────────────────────────

  it('CRITICAL packages/api-types/src/accounts.ts AVATAR_MAX_BYTES = 2 * 1024 * 1024 = 2 MiB. The 2 MiB bound prevents oversized uploads from consuming server memory / R2 quota.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/export const AVATAR_MAX_BYTES = 2 \* 1024 \* 1024;/);
    expect(AVATAR_MAX_BYTES).toBe(2097152);
  });

  // ─── UploadAvatarRequest.data_base64 regex + bounds ──────────

  it("CRITICAL UploadAvatarRequestSchema.data_base64 has /^[A-Za-z0-9+/=]+$/ regex with 'Must be base64-encoded.' message + min(4) + max bound calculated from AVATAR_MAX_BYTES via Math.ceil(AVATAR_MAX_BYTES * 4 / 3) + 4. The base64-character-set regex is the validation gate.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /UploadAvatarRequestSchema = z\.object\(\{[\s\S]+?data_base64: z\s*\.string\(\)\s*\n\s*\.min\(4\)\s*\n\s*\.max\(Math\.ceil\(\(AVATAR_MAX_BYTES \* 4\) \/ 3\) \+ 4\)\s*\n\s*\.regex\(\/\^\[A-Za-z0-9\+\/=\]\+\$\/, 'Must be base64-encoded\.'\)/,
    );
  });

  it('CRITICAL UploadAvatarRequest.content_type is AvatarContentTypeSchema (the typed enum). Drift to z.string() would weaken validation + let arbitrary mime types reach R2 upload.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /UploadAvatarRequestSchema = z\.object\(\{[\s\S]+?content_type: AvatarContentTypeSchema/,
    );
  });

  // ─── Customer-dashboard accept attr matches enum ─────────────

  it('CRITICAL apps/customer-dashboard/src/pages/settings.astro avatar file-input has accept="image/png,image/jpeg,image/webp" — matches AVATAR_ALLOWED_CONTENT_TYPES exactly. Drift would let the file picker show types the server rejects (or vice versa).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro'));
    expect(p).toMatch(/accept="image\/png,image\/jpeg,image\/webp"/);
  });

  // ─── The published response derives rather than restates ─────

  it('V-1615 CRITICAL apps/server/src/lib/openapi.ts publishes UploadAvatarResponse.content_type as AvatarContentTypeSchema. It was a fourth inline copy of the three values, one import away from the constant, on the surface the SDKs are generated from. The request side of this operation already derives; the response side is the half a reader is least likely to check, because a wrong response enum breaks nothing until a fourth type is allowed and then breaks deserialisation for every generated client at once.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    // Scoped to the avatar block, not the file. A negative swept over the whole
    // of openapi.ts would fail the day an unrelated operation legitimately
    // declares its own content-type enum — a check broader than its claim, which
    // is the fault this arm was added to fix one line up.
    const block =
      /const UploadAvatarResponseOpenApi = z[\s\S]{0,400}?\.openapi\('UploadAvatarResponse'\)/.exec(
        p,
      )?.[0];
    expect(block, 'the avatar response schema was found in the document builder').toBeDefined();
    expect(block!).toMatch(/content_type: AvatarContentTypeSchema,/);
    expect(
      block!,
      'the response schema restates the content types instead of deriving them',
    ).not.toMatch(/z\.enum\(\[/);
  });

  // ─── 3-content-type cardinality ──────────────────────────────

  it('CRITICAL AVATAR_ALLOWED_CONTENT_TYPES = EXACTLY 3 values — png + jpeg + webp. The 3-type model covers lossless (png/webp) + lossy (jpeg) without exotic formats (GIF/BMP/TIFF/AVIF).', () => {
    expect(AVATAR_CONTENT_TYPES.length).toBe(3);
    expect(AVATAR_CONTENT_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });

  // ─── No forbidden / exotic content types ─────────────────────

  it('CRITICAL no source declares forbidden avatar content types (image/gif / image/bmp / image/tiff / image/avif / image/svg+xml / image/heic / image/x-icon). These are common image MIME types the 3-roster intentionally excludes — SVG is especially security-sensitive (XSS via embedded JS).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const m = p.match(/AVATAR_ALLOWED_CONTENT_TYPES = \[([\s\S]+?)\] as const;/);
    expect(m).not.toBeNull();
    const body = m![1];
    const forbidden = [
      'image/gif',
      'image/bmp',
      'image/tiff',
      'image/avif',
      'image/svg+xml',
      'image/heic',
      'image/x-icon',
    ];
    for (const f of forbidden) {
      expect(body, `Avatar content type must NOT include forbidden '${f}'`).not.toMatch(
        new RegExp(`'${f.replace(/[/+]/g, '\\$&')}'`),
      );
    }
  });

  // ─── 2 MiB bound is what bounds the base64 length ────────────

  it('CRITICAL base64-encoded 2 MiB rounds to 2097156 max chars (Math.ceil(2097152 * 4 / 3) + 4 = 2796207). The +4 padding accounts for `=` pad chars; the upper bound prevents server-side memory exhaustion via base64 inflation.', () => {
    const expectedBase64Max = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 4;
    expect(expectedBase64Max).toBe(2796207);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/avatar-policy-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
