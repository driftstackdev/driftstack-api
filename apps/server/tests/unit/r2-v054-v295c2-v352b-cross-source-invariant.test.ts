// W970 — r2 V-054 + V-295c2 + V-352b cross-source invariant. Two-
// hundred-ninety-sixth in the drift-guard series. Pins the apps/
// server/src/lib/r2.ts Cloudflare R2 wrapper:
//
//   R2 wrapper framing — 'R2 is S3-compatible: we use the AWS SDK
//   pointed at R2's endpoint. The control plane uses R2 for:
//     - Recordings durability (ndjson session-event logs uploaded
//       async after STOP) — bucket: R2_BUCKET_RECORDINGS.
//     - Cross-device GUI access to recordings (presigned GET URLs).
//     - Future: source-map artifacts from Sentry uploads (separate
//       bucket; not configured here yet)'.
//
//   Sentinel-key readiness framing — 'Sentinel-key readiness probe:
//   HEAD on the well-known key __driftstack_sentinel__ in
//   R2_BUCKET_RECORDINGS. The sentinel is uploaded once at bucket-
//   provisioning time (by the founder, not by the control plane);
//   HEAD returning 404 means the bucket exists and the credentials
//   work but the sentinel is missing — still counts as R2 reachable
//   for readiness, with a separate logged warning. HEAD throwing a
//   credentials/network error is hard-fail'.
//
//   R2_SENTINEL_KEY = '__driftstack_sentinel__' — double-underscore
//     prefix + suffix marks it as a system-reserved key (callers will
//     never collide).
//
//   createR2Client(config) returns the recordings-bucket client by
//     default (config.bucketRecordings).
//
//   V-295c2 createR2PublicClient factory framing — 'V-295c2 — factory
//   for the public-snapshot bucket. Same R2 credentials, different
//   bucket. Returns null when the public bucket is not configured;
//   callers (status-snapshot writer) treat this as feature disabled'.
//
//   createR2ClientForBucket factory wires S3Client:
//     - region: 'auto' (R2 has a single region).
//     - endpoint: config.endpointUrl.
//     - credentials: accessKeyId + secretAccessKey.
//     - forcePathStyle: false (auto-region uses path-style implicitly).
//
//   404 / NotFound handling on headObject — 'e?.$metadata?.
//     httpStatusCode === 404 || e?.name === NotFound' double-condition
//     covers both AWS SDK v3 error envelope shapes.
//
//   presignPut + presignGet default expiresIn = 900 seconds (15 min).
//
//   r2ReadinessCheck name='r2' + timeoutMs=2000 — matches V-225
//     readiness-probe pattern.
//
//   recordingKey shape — 'recordings/<account_id>/<session_id>.ndjson'
//     — 'The account-id prefix lets future per-customer signed-URL
//     scoping work without a key restructure'.
//
//   V-352b avatar-key 4-content-type ladder:
//     - image/png → 'png'.
//     - image/jpeg → 'jpg'.
//     - image/webp → 'webp'.
//     - else → 'bin'.
//   Format: 'avatars/<account_id>.<ext>' — 'Re-uploading replaces the
//   prior object (same key, ext-dependent suffix)'.
//
// stays in lockstep across apps/server/src/lib/r2.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { R2_SENTINEL_KEY, avatarKey, recordingKey, r2ReadinessCheck } from '../../src/lib/r2.js';
import type { R2 } from '../../src/lib/r2.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W970 r2 V-054 + V-295c2 + V-352b cross-source invariant', () => {
  // ─── Header surface framing ──────────────────────────────────

  it("CRITICAL apps/server/src/lib/r2.ts header pins surface — 'R2 is S3-compatible: we use the AWS SDK pointed at R2's endpoint. The control plane uses R2 for: Recordings durability (ndjson session-event logs uploaded async after STOP) — bucket: R2_BUCKET_RECORDINGS. Cross-device GUI access to recordings (presigned GET URLs). Future: source-map artifacts from Sentry uploads (separate bucket; not configured here yet)'. The 3-use-case inventory (recordings + GUI access + future source-maps) is the V-054 + V-295c2 R2 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/R2 is S3-compatible: we use the AWS SDK pointed at R2's endpoint\./);
    expect(p).toMatch(/The control plane uses R2 for:/);
    expect(p).toMatch(/- Recordings durability \(ndjson session-event logs uploaded async/);
    expect(p).toMatch(/after STOP\) — bucket: `R2_BUCKET_RECORDINGS`\./);
    expect(p).toMatch(/- Cross-device GUI access to recordings \(presigned GET URLs\)\./);
    expect(p).toMatch(/- Future: source-map artifacts from Sentry uploads \(separate/);
    expect(p).toMatch(/bucket; not configured here yet\)\./);
  });

  // ─── Sentinel-key readiness framing ──────────────────────────

  it("CRITICAL sentinel-key readiness framing — 'Sentinel-key readiness probe: HEAD on the well-known key __driftstack_sentinel__ in R2_BUCKET_RECORDINGS. The sentinel is uploaded once at bucket-provisioning time (by the founder, not by the control plane); HEAD returning 404 means the bucket exists and the credentials work but the sentinel is missing — still counts as R2 reachable for readiness, with a separate logged warning. HEAD throwing a credentials/network error is hard-fail'. The 404-as-soft-warning + cred-error-as-hard-fail design is the V-225 readiness contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/Sentinel-key readiness probe: HEAD on the well-known key/);
    expect(p).toMatch(/`__driftstack_sentinel__` in `R2_BUCKET_RECORDINGS`\. The sentinel/);
    expect(p).toMatch(/is uploaded once at bucket-provisioning time \(by the founder, not/);
    expect(p).toMatch(/by the control plane\); HEAD returning 404 means the bucket exists/);
    expect(p).toMatch(/and the credentials work but the sentinel is missing — still/);
    expect(p).toMatch(/counts as "R2 reachable" for readiness, with a separate logged/);
    expect(p).toMatch(/warning\. HEAD throwing a credentials\/network error is hard-fail\./);
  });

  // ─── R2_SENTINEL_KEY constant ────────────────────────────────

  it("CRITICAL R2_SENTINEL_KEY = '__driftstack_sentinel__'. The double-underscore prefix + suffix marks it as a system-reserved key (callers won't collide).", () => {
    expect(R2_SENTINEL_KEY).toBe('__driftstack_sentinel__');
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/export const R2_SENTINEL_KEY = '__driftstack_sentinel__';/);
  });

  // ─── R2 interface 6-method surface ───────────────────────────

  it('CRITICAL R2 interface has 7 fields — headObject + putObject + deleteObject + presignPut + presignGet + listObjects + readonly bucket. The surface is what services-under-r2 consume (deleteObject added 2026-06-25 for purged-profile sealed-blob cleanup; listObjects added 2026-07-10 / #158 for the orphan-blob reaper).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/export interface R2 \{/);
    expect(p).toMatch(/headObject\(key: string\): Promise<\{ exists: boolean \}>;/);
    expect(p).toMatch(/putObject\(args: \{/);
    expect(p).toMatch(/deleteObject\(key: string\): Promise<void>;/);
    expect(p).toMatch(/presignPut\(args: \{/);
    expect(p).toMatch(/presignGet\(args: \{/);
    expect(p).toMatch(
      /listObjects\(prefix: string\): Promise<Array<\{ key: string; lastModified: Date \| null \}>>;/,
    );
    expect(p).toMatch(/readonly bucket: string;/);
  });

  // ─── createR2Client recordings-bucket default ────────────────

  it("CRITICAL createR2Client uses config.bucketRecordings — 'return createR2ClientForBucket(config, config.bucketRecordings);'. The default-to-recordings is what makes the most-common call site terse.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/export function createR2Client\(config: R2Config\): R2 \{/);
    expect(p).toMatch(/return createR2ClientForBucket\(config, config\.bucketRecordings\);/);
  });

  // ─── V-295c2 createR2PublicClient null-on-missing ────────────

  it("CRITICAL V-295c2 createR2PublicClient framing — 'V-295c2 — factory for the public-snapshot bucket. Same R2 credentials, different bucket. Returns null when the public bucket is not configured; callers (status-snapshot writer) treat this as feature disabled'. The null-on-missing + same-credentials design is the V-295c2 dual-bucket contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/V-295c2 — factory for the public-snapshot bucket\. Same R2 credentials,/);
    expect(p).toMatch(/different bucket\. Returns null when the public bucket is not configured;/);
    expect(p).toMatch(/callers \(status-snapshot writer\) treat this as "feature disabled"\./);
  });

  it("CRITICAL createR2PublicClient signature + null-guard — 'export function createR2PublicClient(config: R2Config): R2 | null' + 'if (!config.bucketPublic) return null;'. The R2 | null return type is what makes the null-on-missing branch type-safe for callers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/export function createR2PublicClient\(config: R2Config\): R2 \| null \{/);
    expect(p).toMatch(/if \(!config\.bucketPublic\) return null;/);
    expect(p).toMatch(/return createR2ClientForBucket\(config, config\.bucketPublic\);/);
  });

  // ─── S3Client config: 4 keys ─────────────────────────────────

  it("CRITICAL S3ClientConfig has 4 keys — region: 'auto' + endpoint: config.endpointUrl + credentials: { accessKeyId, secretAccessKey } + forcePathStyle: false. The auto-region + path-style:false is what makes the AWS SDK speak R2-compatible.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/region: 'auto',/);
    expect(p).toMatch(/endpoint: config\.endpointUrl,/);
    expect(p).toMatch(/accessKeyId: config\.accessKeyId,/);
    expect(p).toMatch(/secretAccessKey: config\.secretAccessKey,/);
    expect(p).toMatch(/forcePathStyle: false,/);
  });

  it("CRITICAL path-style framing — 'R2 uses path-style access via the auto region'. The path-style-via-auto-region note is the design rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/R2 uses path-style access via the auto region\./);
  });

  // ─── 404 / NotFound double-condition handling ────────────────

  it("CRITICAL headObject 404-handling double-condition — 'e?.$metadata?.httpStatusCode === 404 || e?.name === NotFound'. The 2-shape error-envelope handling covers both AWS SDK v3 stable + transient error variants.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(
      /if \(e\?\.\$metadata\?\.httpStatusCode === 404 \|\| e\?\.name === 'NotFound'\) \{/,
    );
    expect(p).toMatch(/return \{ exists: false \};/);
  });

  // ─── presignPut + presignGet 900-second default ──────────────

  it('CRITICAL presignPut + presignGet default expiresIn = 900. The 900-second (15-minute) default matches AWS-SDK signed-URL recommended-default for client-direct upload/download.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/async presignPut\(\{ key, contentType, expiresIn = 900 \}\) \{/);
    expect(p).toMatch(/async presignGet\(\{ key, expiresIn = 900 \}\) \{/);
  });

  // ─── r2ReadinessCheck shape ──────────────────────────────────

  it("CRITICAL r2ReadinessCheck returns { name: 'r2', timeoutMs: 2000, fn }. The 'r2'-name + 2000ms-timeout matches the V-225 readiness-probe pattern.", () => {
    const r2Stub: R2 = {
      bucket: 'test-bucket',
      headObject: () => Promise.resolve({ exists: true }),
      putObject: () => Promise.resolve(),
      deleteObject: () => Promise.resolve(),
      presignPut: () => Promise.resolve('https://example.com/put'),
      presignGet: () => Promise.resolve('https://example.com/get'),
      listObjects: () => Promise.resolve([]),
    };
    const check = r2ReadinessCheck(r2Stub);
    expect(check.name).toBe('r2');
    expect(check.timeoutMs).toBe(2000);
    expect(typeof check.fn).toBe('function');
  });

  it("CRITICAL r2ReadinessCheck calls headObject with R2_SENTINEL_KEY by default. The default-key parameter is what makes the call site terse: 'r2ReadinessCheck(r2)'.", async () => {
    let observedKey: string | undefined;
    const r2Stub: R2 = {
      bucket: 'test-bucket',
      headObject: (key: string) => {
        observedKey = key;
        return Promise.resolve({ exists: true });
      },
      putObject: () => Promise.resolve(),
      deleteObject: () => Promise.resolve(),
      presignPut: () => Promise.resolve(''),
      presignGet: () => Promise.resolve(''),
      listObjects: () => Promise.resolve([]),
    };
    const check = r2ReadinessCheck(r2Stub);
    await check.fn();
    expect(observedKey).toBe('__driftstack_sentinel__');
  });

  it('CRITICAL r2ReadinessCheck accepts override key — the explicit-key overload lets callers probe arbitrary objects (e.g. per-environment health-check keys).', async () => {
    let observedKey: string | undefined;
    const r2Stub: R2 = {
      bucket: 'test-bucket',
      headObject: (key: string) => {
        observedKey = key;
        return Promise.resolve({ exists: true });
      },
      putObject: () => Promise.resolve(),
      deleteObject: () => Promise.resolve(),
      presignPut: () => Promise.resolve(''),
      presignGet: () => Promise.resolve(''),
      listObjects: () => Promise.resolve([]),
    };
    const check = r2ReadinessCheck(r2Stub, 'custom-health-key');
    await check.fn();
    expect(observedKey).toBe('custom-health-key');
  });

  // ─── recordingKey shape + framing ────────────────────────────

  it("CRITICAL recordingKey shape — 'recordings/<account_id>/<session_id>.ndjson'. The 3-segment + account-prefix design lets future per-customer signed-URL scoping work without a key restructure.", () => {
    expect(recordingKey('acct_123', 'sess_456')).toBe('recordings/acct_123/sess_456.ndjson');
  });

  it("CRITICAL recordingKey framing — 'Recording object key for a given session. Stable shape: recordings/<account_id>/<session_id>.ndjson. The account-id prefix lets future per-customer signed-URL scoping work without a key restructure'. The framing is the V-054 §4 key-shape contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/Recording object key for a given session\. Stable shape:/);
    expect(p).toMatch(/recordings\/<account_id>\/<session_id>\.ndjson/);
    expect(p).toMatch(/The account-id prefix lets future per-customer signed-URL/);
    expect(p).toMatch(/scoping work without a key restructure\./);
  });

  // ─── V-352b avatarKey 4-content-type ladder ──────────────────

  it("CRITICAL V-352b avatarKey 4-content-type ladder — image/png → 'png' + image/jpeg → 'jpg' + image/webp → 'webp' + else → 'bin'. The 3-image-format + bin-fallback design covers customer-uploaded avatar shapes (PNG/JPEG/WebP).", () => {
    expect(avatarKey('acct_X', 'image/png')).toBe('avatars/acct_X.png');
    expect(avatarKey('acct_X', 'image/jpeg')).toBe('avatars/acct_X.jpg');
    expect(avatarKey('acct_X', 'image/webp')).toBe('avatars/acct_X.webp');
    expect(avatarKey('acct_X', 'application/unknown')).toBe('avatars/acct_X.bin');
  });

  it("CRITICAL V-352b avatarKey framing — 'V-352b — avatar object key for a given account on the public-snapshot bucket. Extension matches the uploaded content-type so the presigned GET surfaces a sensible Content-Type header'. The match-content-type-to-extension design is the V-352b avatar contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'));
    expect(p).toMatch(/V-352b — avatar object key for a given account on the public-snapshot/);
    expect(p).toMatch(/bucket\. Extension matches the uploaded content-type so the presigned/);
    expect(p).toMatch(/GET surfaces a sensible Content-Type header\./);
    expect(p).toMatch(/avatars\/<account_id>\.<ext>/);
    expect(p).toMatch(
      /Re-uploading replaces the prior object \(same key, ext-dependent suffix\)\./,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/r2-v054-v295c2-v352b-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
