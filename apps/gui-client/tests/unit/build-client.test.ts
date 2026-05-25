// Unit coverage for buildClient (lib/client). It gates the GUI's
// connected/not-connected state: a null/empty API key must yield null
// (so views render the "set an API key" surface instead of firing
// opaque 401s), and a present key must construct a real SDK client.
// Previously untested.

import { describe, expect, it } from 'vitest';
import { Driftstack } from '@driftstack/sdk';
import { buildClient } from '../../src/lib/client';

const BASE = 'https://api.driftstack.dev';

describe('buildClient (gui-client/lib/client)', () => {
  it('returns null for a null API key (not-connected state)', () => {
    expect(buildClient(null, BASE)).toBeNull();
  });

  it('returns null for an empty-string API key', () => {
    expect(buildClient('', BASE)).toBeNull();
  });

  it('constructs a real Driftstack SDK client when a key is present', () => {
    const client = buildClient('ds_test_key', BASE);
    expect(client).not.toBeNull();
    expect(client).toBeInstanceOf(Driftstack);
  });

  it('builds a client against a localhost base URL too', () => {
    expect(buildClient('ds_test_key', 'http://localhost:3000')).toBeInstanceOf(Driftstack);
  });

  it('treats a whitespace-only key as present (only null/empty are guarded)', () => {
    // Documents the actual guard: `apiKey === null || apiKey.length === 0`.
    // A whitespace key is length>0, so a client is built — the server
    // rejects it with 401, surfaced by the per-view error handling.
    expect(buildClient('   ', BASE)).toBeInstanceOf(Driftstack);
  });
});
