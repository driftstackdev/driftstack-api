// R2 client wrapper unit tests.
//
// We don't hit real R2 here; we mock the underlying S3 client's
// `send` method and verify the wrapper translates commands and
// errors correctly. Integration with real R2 happens at boot when
// the readiness probe runs against the production bucket.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as ClientS3 from '@aws-sdk/client-s3';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof ClientS3>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(function S3ClientMock() {
      return {
        send: sendMock,
      };
    }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://r2.example/presigned-url'),
}));

import {
  createR2Client,
  createR2PublicClient,
  r2ReadinessCheck,
  recordingKey,
  profileSealedBlobKey,
  R2_SENTINEL_KEY,
} from '../../src/lib/r2.js';

const config = {
  accountId: 'acc',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  bucketRecordings: 'recordings',
  bucketPublic: null,
  endpointUrl: 'https://acc.r2.cloudflarestorage.com',
};

beforeEach(() => {
  sendMock.mockReset();
});

describe('createR2Client.headObject', () => {
  it('returns { exists: true } on 200', async () => {
    sendMock.mockResolvedValueOnce({});
    const r2 = createR2Client(config);
    await expect(r2.headObject('foo')).resolves.toEqual({ exists: true });
  });

  it('returns { exists: false } on 404 by httpStatusCode', async () => {
    sendMock.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    const r2 = createR2Client(config);
    await expect(r2.headObject('foo')).resolves.toEqual({ exists: false });
  });

  it('returns { exists: false } on NotFound by name', async () => {
    sendMock.mockRejectedValueOnce({ name: 'NotFound' });
    const r2 = createR2Client(config);
    await expect(r2.headObject('foo')).resolves.toEqual({ exists: false });
  });

  it('rethrows on credentials / network error', async () => {
    sendMock.mockRejectedValueOnce(new Error('credentials missing'));
    const r2 = createR2Client(config);
    await expect(r2.headObject('foo')).rejects.toThrow('credentials missing');
  });
});

describe('createR2Client.putObject', () => {
  it('passes bucket + key + body to PutObjectCommand', async () => {
    sendMock.mockResolvedValueOnce({});
    const r2 = createR2Client(config);
    await r2.putObject({
      key: 'recordings/acc/sess.ndjson',
      body: 'payload',
      contentType: 'application/x-ndjson',
    });
    expect(sendMock).toHaveBeenCalledOnce();
    const cmd = sendMock.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input).toMatchObject({
      Bucket: 'recordings',
      Key: 'recordings/acc/sess.ndjson',
      Body: 'payload',
      ContentType: 'application/x-ndjson',
    });
  });
});

describe('createR2Client.presignPut / presignGet', () => {
  it('returns a presigned URL string', async () => {
    const r2 = createR2Client(config);
    await expect(r2.presignPut({ key: 'foo' })).resolves.toBe('https://r2.example/presigned-url');
    await expect(r2.presignGet({ key: 'foo' })).resolves.toBe('https://r2.example/presigned-url');
  });
});

describe('r2ReadinessCheck', () => {
  it('passes when sentinel HEAD resolves (200)', async () => {
    sendMock.mockResolvedValueOnce({});
    const r2 = createR2Client(config);
    const check = r2ReadinessCheck(r2);
    expect(check.name).toBe('r2');
    expect(check.timeoutMs).toBe(2000);
    await expect(check.fn()).resolves.toEqual({ exists: true });
  });

  it('passes (with exists:false) when sentinel HEAD returns 404', async () => {
    sendMock.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    const r2 = createR2Client(config);
    const check = r2ReadinessCheck(r2);
    await expect(check.fn()).resolves.toEqual({ exists: false });
  });

  it('fails when sentinel HEAD throws credentials error', async () => {
    sendMock.mockRejectedValueOnce(new Error('access denied'));
    const r2 = createR2Client(config);
    const check = r2ReadinessCheck(r2);
    await expect(check.fn()).rejects.toThrow('access denied');
  });

  it('uses sentinel key by default', () => {
    expect(R2_SENTINEL_KEY).toBe('__driftstack_sentinel__');
  });
});

describe('recordingKey', () => {
  it('returns the canonical key shape', () => {
    expect(recordingKey('acc_123', 'sess_abc')).toBe('recordings/acc_123/sess_abc.ndjson');
  });
});

describe('profileSealedBlobKey', () => {
  it('returns the canonical profile sealed-blob key shape (keyed by profile_id)', () => {
    expect(profileSealedBlobKey('a74c2abf-0000-4000-8000-000000000001')).toBe(
      'profiles/a74c2abf-0000-4000-8000-000000000001.sealed',
    );
  });
});

// V-1438 — `createR2PublicClient` had never been called. Coverage: the function
// executed 0 times and BOTH arms of its `if (!config.bucketPublic) return null;`
// were dark. It is not unguarded, though: `lib-r2-content-parity` pins its entire
// body as a regex and `r2-v054-v295c2-v352b-cross-source-invariant` pins the
// signature and the null-guard line again. Three text pins across two files, on a
// function nothing ran.
//
// The property that matters is not the null return. It is WHICH BUCKET the client
// targets. The two factories share credentials and differ only in the bucket they
// close over, and bootstrap's own comment says why that separation exists: "The
// recordings bucket is intentionally NOT used — recordings contain Customer Data and
// must remain private." A copy-paste returning the recordings client would satisfy
// "non-null", satisfy every text pin, and publish Customer Data to a bucket whose
// whole purpose is being world-readable.
describe('createR2PublicClient (V-295c2 dual-bucket separation)', () => {
  it('returns null when the public bucket is unconfigured, which is how the status-snapshot writer learns the feature is off', () => {
    expect(createR2PublicClient(config)).toBeNull();
  });

  it('CRITICAL targets the PUBLIC bucket and never the recordings one. Both factories take the same credentials and differ only in the bucket they close over, so a client built from the wrong one would write Customer Data — session recordings — into the world-readable bucket. Non-null is not the property; the bucket is.', () => {
    const pub = createR2PublicClient({ ...config, bucketPublic: 'public-snapshots' });
    expect(pub).not.toBeNull();
    expect(pub?.bucket).toBe('public-snapshots');
    expect(
      pub?.bucket,
      'the public client resolved to the recordings bucket — Customer Data would be written to a public bucket',
    ).not.toBe(config.bucketRecordings);
  });

  it('CONTROL the recordings factory still targets the recordings bucket with the same config, so the arm above is a separation between two live factories rather than a claim about one', () => {
    expect(createR2Client({ ...config, bucketPublic: 'public-snapshots' }).bucket).toBe(
      config.bucketRecordings,
    );
  });
});
