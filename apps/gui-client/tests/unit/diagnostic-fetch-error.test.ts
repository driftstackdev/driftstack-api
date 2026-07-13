// Behavior coverage for diagnosticFetchError (lib/diagnostic-fetch-error).
// It powers the GUI's network-failure error copy: detect a fetch/network
// failure and return a multi-line actionable diagnostic, or null so the
// caller's per-view friendlyError (DriftstackError status copy) takes
// over. Only content-parity tests pinned the source text before; the
// branching behavior — network detection, the null fallthrough, and the
// localhost-vs-remote guidance — was untested.

import { describe, expect, it } from 'vitest';
import { diagnosticFetchError } from '../../src/lib/diagnostic-fetch-error.js';

const URL_LOCAL = 'http://localhost:3000';
const URL_REMOTE = 'https://api.driftstack.dev';

describe('diagnosticFetchError', () => {
  it('returns null for non-network errors so per-view friendlyError can take over', () => {
    expect(diagnosticFetchError(new Error('Profile name already exists'), URL_REMOTE)).toBeNull();
    expect(diagnosticFetchError({ message: 'validation failed' }, URL_REMOTE)).toBeNull();
    expect(diagnosticFetchError('some unrelated string', URL_REMOTE)).toBeNull();
  });

  it('detects every network-failure signature → non-null diagnostic', () => {
    for (const msg of [
      'Load failed', // WebKit / Tauri
      'Failed to fetch', // Chrome
      'NetworkError when attempting to fetch resource', // Firefox
      'connect ECONNREFUSED 127.0.0.1:3000', // Node
      'fetch failed', // undici
      'getaddrinfo ENOTFOUND api.driftstack.dev', // DNS
    ]) {
      expect(diagnosticFetchError(new Error(msg), URL_REMOTE), msg).not.toBeNull();
    }
  });

  it('includes the target URL without exposing the underlying raw error', () => {
    const out = diagnosticFetchError(
      new Error('Load failed private-api.internal /Users/customer token=secret'),
      URL_REMOTE,
    );
    expect(out).toContain(URL_REMOTE);
    expect(out).not.toMatch(/private-api|\/Users|token=secret|Underlying error/i);
  });

  it('localhost target → self-host setup guidance (start the server / Cloud mode)', () => {
    const out = diagnosticFetchError(new Error('Failed to fetch'), URL_LOCAL) ?? '';
    expect(out).toContain('Start the server');
    expect(out).toContain('Cloud mode');
    expect(out).not.toContain('reachable from this machine');
  });

  it('remote target → reachability guidance (network / scheme), not self-host setup', () => {
    const out = diagnosticFetchError(new Error('Failed to fetch'), URL_REMOTE) ?? '';
    expect(out).toContain('reachable from this machine');
    expect(out).toContain('http vs https');
    expect(out).not.toContain('Start the server');
  });

  it('reads the message off a plain string error (no message property)', () => {
    // String(err) path: a bare string that matches the network regex.
    expect(diagnosticFetchError('fetch failed', URL_REMOTE)).not.toBeNull();
  });
});
