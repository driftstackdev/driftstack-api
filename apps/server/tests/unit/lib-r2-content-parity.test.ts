// W389.C — drift guard for apps/server/src/lib/r2.ts.
// Cloudflare R2 (S3-compat) wrapper. Two consumers + a readiness
// probe + key-derivation helpers. The sentinel-key readiness contract
// and the V-352b avatar/V-295c2 public-bucket factories are
// referenced by ops runbooks and the boot-time readiness composer.
//
//   • R2 S3-compatibility framing + 3 consumer paths (recordings
//     durability / cross-device presigned GET / source-map artefacts).
//   • R2_SENTINEL_KEY = "__driftstack_sentinel__".
//   • 404 sentinel-missing → still "reachable" / hard-fail on
//     credentials/network errors.
//   • R2 interface 4-method shape (headObject / putObject /
//     presignPut / presignGet) + readonly bucket.
//   • createR2Client → recordings bucket.
//   • V-295c2 createR2PublicClient → null when bucketPublic absent.
//   • presigned URLs default to 900s (15-min) expiresIn.
//   • r2ReadinessCheck: 2000ms timeout, name='r2'.
//   • recordingKey shape: `recordings/<account_id>/<session_id>.ndjson`.
//   • V-352b avatarKey: image/png/jpeg/webp → png/jpg/webp, else
//     "bin" fallback; key shape `avatars/<account_id>.<ext>`.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W389.C apps/server/src/lib/r2.ts content parity', () => {
  const body = read(LIB);

  it('S3-compatibility framing + AWS SDK endpoint pin pinned', () => {
    expect(body).toMatch(/R2 is S3-compatible: we use the AWS SDK pointed at R2's endpoint/);
  });

  it('3 consumer paths framing: recordings durability / cross-device presigned GET / future source-map artefacts', () => {
    expect(body).toMatch(
      /Recordings durability \(ndjson session-event logs uploaded async\s*\/\/\s*after STOP\) — bucket: `R2_BUCKET_RECORDINGS`/,
    );
    expect(body).toMatch(/Cross-device GUI access to recordings \(presigned GET URLs\)\./);
    expect(body).toMatch(
      /Future: source-map artifacts from Sentry uploads \(separate\s*\/\/\s*bucket; not configured here yet\)/,
    );
  });

  it('R2_SENTINEL_KEY constant pinned: "__driftstack_sentinel__"', () => {
    expect(body).toMatch(/export const R2_SENTINEL_KEY = '__driftstack_sentinel__';/);
  });

  it('sentinel-readiness 404 framing: bucket reachable but sentinel missing → still passes; credentials/network errors hard-fail', () => {
    expect(body).toMatch(
      /Sentinel-key readiness probe: HEAD on the well-known key\s*\/\/\s*`__driftstack_sentinel__` in `R2_BUCKET_RECORDINGS`/,
    );
    expect(body).toMatch(
      /HEAD returning 404 means the bucket exists\s*\/\/\s*and the credentials work but the sentinel is missing — still\s*\/\/\s*counts as "R2 reachable" for readiness, with a separate logged\s*\/\/\s*warning\. HEAD throwing a credentials\/network error is hard-fail/,
    );
  });

  it('R2 interface: 6 methods (incl. deleteObject + #158 listObjects) + readonly bucket', () => {
    expect(body).toMatch(/export interface R2 \{/);
    expect(body).toMatch(/headObject\(key: string\): Promise<\{ exists: boolean \}>;/);
    expect(body).toMatch(
      /putObject\(args: \{\s*key: string;\s*body: Buffer \| Uint8Array \| string;\s*contentType\?: string;\s*\}\): Promise<void>;/,
    );
    expect(body).toMatch(/deleteObject\(key: string\): Promise<void>;/);
    expect(body).toMatch(
      /presignPut\(args: \{ key: string; contentType\?: string; expiresIn\?: number \}\): Promise<string>;/,
    );
    expect(body).toMatch(
      /presignGet\(args: \{ key: string; expiresIn\?: number \}\): Promise<string>;/,
    );
    // #158 — orphan-blob reaper enumeration surface (requires s3:ListBucket).
    expect(body).toMatch(
      /listObjects\(prefix: string\): Promise<Array<\{ key: string; lastModified: Date \| null \}>>;/,
    );
    expect(body).toMatch(/readonly bucket: string;/);
  });

  it('createR2Client: returns client bound to bucketRecordings', () => {
    expect(body).toMatch(
      /export function createR2Client\(config: R2Config\): R2 \{\s*return createR2ClientForBucket\(config, config\.bucketRecordings\);\s*\}/,
    );
  });

  it('V-295c2 createR2PublicClient: returns null when bucketPublic absent (status-snapshot writer treats as feature-disabled)', () => {
    expect(body).toMatch(
      /V-295c2 — factory for the public-snapshot bucket\. Same R2 credentials,\s*\*\s*different bucket\. Returns null when the public bucket is not configured;\s*\*\s*callers \(status-snapshot writer\) treat this as "feature disabled"/,
    );
    expect(body).toMatch(
      /export function createR2PublicClient\(config: R2Config\): R2 \| null \{\s*if \(!config\.bucketPublic\) return null;\s*return createR2ClientForBucket\(config, config\.bucketPublic\);\s*\}/,
    );
  });

  it('S3Client config: region=auto, endpoint=config.endpointUrl, forcePathStyle=false, requestHandler timeouts (connect 3s / request 15s)', () => {
    expect(body).toMatch(/region: 'auto',/);
    expect(body).toMatch(/endpoint: config\.endpointUrl,/);
    expect(body).toMatch(
      /credentials: \{\s*accessKeyId: config\.accessKeyId,\s*secretAccessKey: config\.secretAccessKey,\s*\},/,
    );
    expect(body).toMatch(
      /\/\/ R2 uses path-style access via the auto region\.\s*forcePathStyle: false,/,
    );
    // Bounded R2 requests so a stuck connection can't hang a background worker
    // (AWS SDK v3 has maxAttempts:3 but NO socket timeout by default).
    expect(body).toMatch(/requestHandler: \{ connectionTimeout: 3000, requestTimeout: 15000 \}/);
  });

  it('headObject: returns {exists:false} on 404 or NotFound name; rethrows other errors', () => {
    expect(body).toMatch(
      /if \(e\?\.\$metadata\?\.httpStatusCode === 404 \|\| e\?\.name === 'NotFound'\) \{\s*return \{ exists: false \};\s*\}\s*throw err;/,
    );
  });

  it('presignPut + presignGet: default expiresIn=900 (15-min)', () => {
    expect(body).toMatch(/async presignPut\(\{ key, contentType, expiresIn = 900 \}\)/);
    expect(body).toMatch(/async presignGet\(\{ key, expiresIn = 900 \}\)/);
    expect(body).toMatch(/return getSignedUrl\(s3, cmd, \{ expiresIn \}\);/);
  });

  it('r2ReadinessCheck: name="r2", timeoutMs=2000, fn = HEAD sentinel', () => {
    expect(body).toMatch(
      /Readiness probe: HEAD the sentinel key\. Treats 404 as "bucket\s*\*\s*reachable but sentinel missing" — still passes/,
    );
    expect(body).toMatch(
      /export function r2ReadinessCheck\(r2: R2, key: string = R2_SENTINEL_KEY\): ReadinessCheck \{\s*return \{\s*name: 'r2',\s*timeoutMs: 2000,\s*fn: async \(\) => r2\.headObject\(key\),\s*\};/,
    );
  });

  it('recordingKey: stable shape "recordings/<account_id>/<session_id>.ndjson"', () => {
    expect(body).toMatch(
      /Recording object key for a given session\. Stable shape:\s*\*\s*recordings\/<account_id>\/<session_id>\.ndjson/,
    );
    expect(body).toMatch(
      /export function recordingKey\(accountId: string, sessionId: string\): string \{\s*return `recordings\/\$\{accountId\}\/\$\{sessionId\}\.ndjson`;\s*\}/,
    );
  });

  it('profile-backed: profileSealedBlobKey shape "profiles/<profile_id>.sealed" (keyed by profile_id uuid; opaque blob)', () => {
    expect(body).toMatch(
      /export function profileSealedBlobKey\(profileId: string\): string \{\s*return `profiles\/\$\{profileId\}\.sealed`;\s*\}/,
    );
  });

  it('V-352b avatarKey: png/jpg/webp → matching ext, else "bin"; shape "avatars/<account_id>.<ext>"', () => {
    expect(body).toMatch(
      /V-352b — avatar object key for a given account on the public-snapshot\s*\*\s*bucket\. Extension matches the uploaded content-type so the presigned\s*\*\s*GET surfaces a sensible Content-Type header\./,
    );
    expect(body).toMatch(
      /contentType === 'image\/png'\s*\?\s*'png'\s*:\s*contentType === 'image\/jpeg'\s*\?\s*'jpg'\s*:\s*contentType === 'image\/webp'\s*\?\s*'webp'\s*:\s*'bin';/,
    );
    expect(body).toMatch(/return `avatars\/\$\{accountId\}\.\$\{ext\}`;/);
  });

  it('imports: @aws-sdk/client-s3 (S3Client + 5 commands incl. DeleteObjectCommand + #158 ListObjectsV2Command) + @aws-sdk/s3-request-presigner', () => {
    expect(body).toMatch(
      /import \{\s*S3Client,\s*HeadObjectCommand,\s*PutObjectCommand,\s*GetObjectCommand,\s*DeleteObjectCommand,\s*ListObjectsV2Command,\s*type S3ClientConfig,\s*\} from '@aws-sdk\/client-s3';/,
    );
    expect(body).toMatch(/import \{ getSignedUrl \} from '@aws-sdk\/s3-request-presigner';/);
  });

  it('imports: ReadinessCheck type from ./app.js + R2Config type from ./config.js', () => {
    expect(body).toMatch(/import type \{ ReadinessCheck \} from '\.\/app\.js';/);
    expect(body).toMatch(/import type \{ R2Config \} from '\.\/config\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
