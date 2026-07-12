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
