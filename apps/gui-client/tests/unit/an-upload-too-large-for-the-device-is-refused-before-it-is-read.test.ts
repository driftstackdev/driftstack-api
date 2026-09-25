// An upload too large for the device is refused before the file is read.
//
// A file travels to the device in one message, and each device takes messages
// up to its own size. The session read publishes the resulting per-file limit as
// `upload_max_file_bytes`; the simulator keeps it and checks a picked file
// against it BEFORE reading it, with the same sentence the server answers a 413
// with. When the limit is not known (an older server, no device connected) the
// 64 MiB absolute ceiling still applies. The drop zone names the same limit
// before a file is picked. A 413 the server does send is shown in the client's
// own words with the limit it carried — never the server's detail or title,
// which the installed client does not show (lib/api-errors) — and a cookie jar
// the device cannot take says so instead of "please try again".

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/settings', () => ({
  loadSettings: vi.fn().mockResolvedValue({ apiKey: 'ds_test', baseUrl: 'https://api.test' }),
  loadBaseUrl: vi.fn().mockResolvedValue('https://api.test'),
}));

import {
  AgentSessionControlError,
  getAgentSession,
  uploadAgentSessionFile,
} from '../../src/lib/agent-session-control';
import {
  cookieImportRefusalNote,
  uploadFailureNote,
  uploadLimitLabel,
  uploadRefusalNote,
} from '../../src/lib/upload-size-limit';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function ok(body: unknown): unknown {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

afterEach(() => {
  mockFetch.mockReset();
});

const MIB = 1024 * 1024;

describe('the session read carries the device’s upload limit', () => {
  it('CRITICAL keeps a positive integer upload_max_file_bytes', async () => {
    mockFetch.mockResolvedValue(
      ok({ mode: 'manual', status: 'active', upload_max_file_bytes: 3_093_504 }),
    );
    expect(await getAgentSession('agt_1')).toMatchObject({ uploadMaxFileBytes: 3_093_504 });
  });

  for (const bad of [0, -1, 1.5, '3093504', null]) {
    it(`CRITICAL drops ${JSON.stringify(bad)} rather than trusting it`, async () => {
      mockFetch.mockResolvedValue(
        ok({ mode: 'manual', status: 'active', upload_max_file_bytes: bad }),
      );
      expect(await getAgentSession('agt_1')).not.toHaveProperty('uploadMaxFileBytes');
    });
  }

  it('CRITICAL an older server that sends nothing leaves the field absent', async () => {
    mockFetch.mockResolvedValue(ok({ mode: 'manual', status: 'active' }));
    expect(await getAgentSession('agt_1')).not.toHaveProperty('uploadMaxFileBytes');
  });
});

describe('a picked file is checked before it is read', () => {
  const file = (size: number) => ({ name: 'report.pdf', size });

  it('CRITICAL a file over the device limit is refused with the server’s sentence and the limit', () => {
    expect(uploadRefusalNote(file(3_093_505), 3_093_504)).toBe(
      'This file is too large to send to this device (limit 2.95 MiB).',
    );
  });

  it('CRITICAL a file at the device limit is allowed', () => {
    expect(uploadRefusalNote(file(3_093_504), 3_093_504)).toBeNull();
  });

  it('CRITICAL with no device limit known, the 64 MiB ceiling still refuses', () => {
    expect(uploadRefusalNote(file(64 * MIB), null)).toBeNull();
    expect(uploadRefusalNote(file(64 * MIB + 1), null)).toBe(
      'report.pdf is too large (max 64 MiB).',
    );
  });

  it('CRITICAL a device limit above the ceiling never raises it', () => {
    expect(uploadRefusalNote(file(64 * MIB + 1), 96 * MIB)).toBe(
      'report.pdf is too large (max 64 MiB).',
    );
  });

  it('labels whole and small limits the way the server does', () => {
    expect(uploadRefusalNote(file(2 * MIB), MIB)).toBe(
      'This file is too large to send to this device (limit 1 MiB).',
    );
    expect(uploadRefusalNote(file(20_000), 10_240)).toBe(
      'This file is too large to send to this device (limit 10 KiB).',
    );
  });
});

describe('the limit is named before a file is picked', () => {
  it('CRITICAL the hint names the session’s device limit when it is known', () => {
    expect(uploadLimitLabel(3_093_504)).toBe('2.95 MiB');
  });

  it('CRITICAL with no device limit known, the hint names the 64 MiB maximum', () => {
    expect(uploadLimitLabel(null)).toBe('64 MiB');
  });

  it('a device that takes more than the maximum never raises the hint above it', () => {
    expect(uploadLimitLabel(96 * MIB)).toBe('64 MiB');
  });
});

/** The problem document the server answers a size refusal with. */
function problem413(extensions: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      type: 'https://errors.driftstack.dev/payload-too-large',
      title: 'Payload Too Large',
      status: 413,
      detail: 'SERVER-DETAIL-NOT-FOR-THE-CLIENT',
      ...extensions,
    }),
    { status: 413, headers: { 'content-type': 'application/problem+json' } },
  );
}

async function uploadRefusedWith(res: Response): Promise<unknown> {
  mockFetch.mockResolvedValue(res);
  try {
    await uploadAgentSessionFile('agt_1', { name: 'a.bin', mime: 'x/y', dataB64: 'AAAA' });
  } catch (err) {
    return err;
  }
  throw new Error('the 413 did not throw');
}

describe('a refusal from the server is shown in the client’s own words', () => {
  it('CRITICAL a 413 names the limit it carried — never the server’s detail', async () => {
    const err = await uploadRefusedWith(problem413({ limit_bytes: 3_093_504, size_bytes: 4e6 }));
    const note = uploadFailureNote(err, null);
    expect(note).toBe('This file is too large to send to this device (limit 2.95 MiB).');
    expect(note).not.toContain('SERVER-DETAIL');
  });

  it('CRITICAL the limit on the refusal wins over an older one from the session read', async () => {
    const err = await uploadRefusedWith(problem413({ limit_bytes: 1_048_576, size_bytes: 2e6 }));
    expect(uploadFailureNote(err, 3_093_504)).toBe(
      'This file is too large to send to this device (limit 1 MiB).',
    );
  });

  it('CRITICAL a 413 without a limit uses the one from the session read', async () => {
    const err = await uploadRefusedWith(problem413({}));
    expect(uploadFailureNote(err, 3_093_504)).toBe(
      'This file is too large to send to this device (limit 2.95 MiB).',
    );
  });

  it('CRITICAL a 413 with no limit anywhere gets fixed copy — not "Payload Too Large", not "HTTP 413"', async () => {
    const err = await uploadRefusedWith(problem413({}));
    expect(uploadFailureNote(err, null)).toBe(
      'That is too large to send. Choose something smaller and try again.',
    );
    const bare = await uploadRefusedWith(new Response('', { status: 413 }));
    expect(uploadFailureNote(bare, null)).toBe(
      'That is too large to send. Choose something smaller and try again.',
    );
  });

  for (const bad of [0, -1, 1.5, '3093504', null, 2 ** 60]) {
    it(`a limit_bytes of ${JSON.stringify(bad)} is not trusted`, async () => {
      const err = await uploadRefusedWith(problem413({ limit_bytes: bad }));
      expect((err as { limitBytes?: unknown }).limitBytes).toBeNull();
    });
  }

  it('every other failure keeps the reachability note', () => {
    const note = "Couldn't upload — the device isn't reachable right now.";
    expect(
      uploadFailureNote(new AgentSessionControlError('HTTP 503', 503, 'feature-unavailable'), null),
    ).toBe(note);
    expect(uploadFailureNote(new Error('network'), 3_093_504)).toBe(note);
  });
});

describe('a cookie jar the device cannot take', () => {
  it('CRITICAL is refused in the same words the server uses, with the limit it carried', () => {
    const err = new AgentSessionControlError('ignored', 413, 'payload-too-large', null, 4_128_768);
    expect(cookieImportRefusalNote(err)).toBe(
      'This cookie jar is too large to send to this device (limit 3.94 MiB).',
    );
  });

  it('CRITICAL without a limit it still says the jar is too large — never "try again"', () => {
    const err = new AgentSessionControlError('Payload Too Large', 413, 'payload-too-large');
    expect(cookieImportRefusalNote(err)).toBe(
      'This cookie jar is too large to send to this device.',
    );
  });
});
