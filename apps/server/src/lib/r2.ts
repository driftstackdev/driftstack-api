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
