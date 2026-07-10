// Cloudflare R2 client wrapper.
//
// R2 is S3-compatible: we use the AWS SDK pointed at R2's endpoint.
// The control plane uses R2 for:
//   - Recordings durability (ndjson session-event logs uploaded async
//     after STOP) — bucket: `R2_BUCKET_RECORDINGS`.
//   - Cross-device GUI access to recordings (presigned GET URLs).
//   - Future: source-map artifacts from Sentry uploads (separate
//     bucket; not configured here yet).
//
// Sentinel-key readiness probe: HEAD on the well-known key
// `__driftstack_sentinel__` in `R2_BUCKET_RECORDINGS`. The sentinel
// is uploaded once at bucket-provisioning time (by the founder, not
// by the control plane); HEAD returning 404 means the bucket exists
// and the credentials work but the sentinel is missing — still
// counts as "R2 reachable" for readiness, with a separate logged
// warning. HEAD throwing a credentials/network error is hard-fail.

import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ReadinessCheck } from './app.js';
import type { R2Config } from './config.js';

export const R2_SENTINEL_KEY = '__driftstack_sentinel__';

export interface R2 {
  /**
   * HEAD an object. Resolves with `{ exists: true }` on 200, `{ exists: false }`
   * on 404, throws on any other error (credentials, network, server error).
   */
  headObject(key: string): Promise<{ exists: boolean }>;
  /**
   * Upload a buffer or string to R2. Used by recordings ingestion +
   * any future server-side write path.
   */
  putObject(args: {
    key: string;
    body: Buffer | Uint8Array | string;
    contentType?: string;
  }): Promise<void>;
  /**
   * Delete an object. S3/R2 DELETE is idempotent — deleting a key that doesn't
   * exist returns 204, not an error — so callers needn't pre-check existence
   * (a never-saved profile simply has no blob). Resolves on success; throws
   * only on a credentials/network/server error (not on a missing object).
   */
  deleteObject(key: string): Promise<void>;
  /**
   * Generate a presigned PUT URL for a client to upload directly.
   * Used by Mac Mini fleet recording-frame uploads (per V-054 §4)
   * and any future direct-upload flow.
   */
  presignPut(args: { key: string; contentType?: string; expiresIn?: number }): Promise<string>;
  /**
   * Generate a presigned GET URL for cross-device read of a private
   * object (recordings download in the GUI).
   */
  presignGet(args: { key: string; expiresIn?: number }): Promise<string>;
  /**
   * List every object under `prefix` (paginating internally), returning each
   * key + its lastModified timestamp. Used by the profile-blob orphan reaper
   * (GDPR erasure backstop, #158) to enumerate `profiles/*.sealed` objects and
   * cross-check them against the DB.
   *
   * ⚠️ Requires the `s3:ListBucket` permission on the bucket — a scoped R2 token
   * granted only object read/write (Get/Put/Delete) will make this throw
   * `AccessDenied`. That may need an ops grant on the credentials. This method
   * deliberately does NOT swallow that error: it lets it propagate so the caller
   * (the reaper) can catch + log it once and no-op the pass rather than the
   * failure being silently absorbed here.
   */
  listObjects(prefix: string): Promise<Array<{ key: string; lastModified: Date | null }>>;
  /** Bucket the client is configured against. */
  readonly bucket: string;
}

export function createR2Client(config: R2Config): R2 {
  return createR2ClientForBucket(config, config.bucketRecordings);
}

/**
 * V-295c2 — factory for the public-snapshot bucket. Same R2 credentials,
 * different bucket. Returns null when the public bucket is not configured;
 * callers (status-snapshot writer) treat this as "feature disabled".
 */
export function createR2PublicClient(config: R2Config): R2 | null {
  if (!config.bucketPublic) return null;
  return createR2ClientForBucket(config, config.bucketPublic);
}

function createR2ClientForBucket(config: R2Config, bucket: string): R2 {
  const clientConfig: S3ClientConfig = {
    region: 'auto',
    endpoint: config.endpointUrl,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // R2 uses path-style access via the auto region.
    forcePathStyle: false,
    // Bound every R2 request so a stuck connection can't hang a background
    // worker (recording upload / status-snapshot write) indefinitely. AWS
    // SDK v3 retries up to maxAttempts (default 3) but sets NO socket timeout
    // by default — a hung-but-not-erroring connection would never trip a
    // retry. connectionTimeout caps the TCP connect; requestTimeout caps
    // socket inactivity. Generous (3s / 15s) so normal sub-second R2 ops are
    // unaffected; only true hangs are cut (then maxAttempts retries apply).
    requestHandler: { connectionTimeout: 3000, requestTimeout: 15000 },
  };
  const s3 = new S3Client(clientConfig);

  return {
    bucket,

    async headObject(key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { exists: true };
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') {
          return { exists: false };
        }
        throw err;
      }
    },

    async putObject({ key, body, contentType }) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    async deleteObject(key) {
      // S3/R2 DELETE is idempotent: a missing key returns 204 (no NoSuchKey
      // error), so this is safe to call for a never-saved profile's blob.
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async presignPut({ key, contentType, expiresIn = 900 }) {
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      });
      return getSignedUrl(s3, cmd, { expiresIn });
    },

    async presignGet({ key, expiresIn = 900 }) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      return getSignedUrl(s3, cmd, { expiresIn });
    },

    async listObjects(prefix) {
      // Paginate ListObjectsV2 via ContinuationToken until IsTruncated is false.
      // Bounded defensively at ~50k keys so a pathological bucket can't make the
      // reaper's pass run unbounded / OOM; if the cap is hit we stop + log (the
      // profiles/ prefix should never approach this — one key per profile).
      const MAX_KEYS = 50_000;
      const out: Array<{ key: string; lastModified: Date | null }> = [];
      let continuationToken: string | undefined;
      // AccessDenied (missing s3:ListBucket) is NOT caught here — it propagates so
      // the reaper catches + logs it once and no-ops the pass (see the interface
      // JSDoc). Swallowing it here would hide a missing-permission from the caller.
      do {
        const resp = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const item of resp.Contents ?? []) {
          if (item.Key === undefined) continue;
          out.push({ key: item.Key, lastModified: item.LastModified ?? null });
          if (out.length >= MAX_KEYS) break;
        }
        if (out.length >= MAX_KEYS) {
          console.warn(
            `[r2] listObjects('${prefix}') hit the ${MAX_KEYS.toString()}-key cap; results truncated`,
          );
          break;
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (continuationToken !== undefined);
      return out;
    },
  };
}

/**
 * Readiness probe: HEAD the sentinel key. Treats 404 as "bucket
 * reachable but sentinel missing" — still passes (logs a warning at
 * boot is the founder's responsibility); any other error fails.
 *
 * Caller can override `key` to probe a different known object.
 */
export function r2ReadinessCheck(r2: R2, key: string = R2_SENTINEL_KEY): ReadinessCheck {
  return {
    name: 'r2',
    timeoutMs: 2000,
    fn: async () => r2.headObject(key),
  };
}

/**
 * Recording object key for a given session. Stable shape:
 *   recordings/<account_id>/<session_id>.ndjson
 * The account-id prefix lets future per-customer signed-URL
 * scoping work without a key restructure.
 */
export function recordingKey(accountId: string, sessionId: string): string {
  return `recordings/${accountId}/${sessionId}.ndjson`;
}

/**
 * Profile-backed sessions (A3 W177/W417) — R2 object key for a profile's
 * encrypted sealed-blob store. Keyed by profile_id alone (a uuid, globally
 * unique): the dispatch loads it as `sealed_blob`/`sealed_blob_url` on assign,
 * and the profileSaved consumer overwrites it on session end. The blob is
 * opaque (LZFSE+AES-GCM-256, per-profile DEK) so the key needn't account-scope
 * for confidentiality — the DEK is the gate; re-save replaces (same key).
 */
export function profileSealedBlobKey(profileId: string): string {
  return `profiles/${profileId}.sealed`;
}

/**
 * V-352b — avatar object key for a given account on the public-snapshot
 * bucket. Extension matches the uploaded content-type so the presigned
 * GET surfaces a sensible Content-Type header.
 *   avatars/<account_id>.<ext>
 * Re-uploading replaces the prior object (same key, ext-dependent suffix).
 */
export function avatarKey(accountId: string, contentType: string): string {
  const ext =
    contentType === 'image/png'
      ? 'png'
      : contentType === 'image/jpeg'
        ? 'jpg'
        : contentType === 'image/webp'
          ? 'webp'
          : 'bin';
  return `avatars/${accountId}.${ext}`;
}
