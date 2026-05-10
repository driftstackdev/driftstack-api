import { describe, it, expect, vi } from 'vitest';
import { parseDeepLink, dispatchDeepLink } from '../../src/lib/deep-link';

describe('parseDeepLink — cli-authorize', () => {
  it('parses a well-formed auth callback URL', () => {
    const result = parseDeepLink('driftstack://auth/callback?code=abc123&state=xyz789');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        kind: 'cli-authorize',
        code: 'abc123',
        state: 'xyz789',
      });
    }
  });

  it('rejects missing code', () => {
    const result = parseDeepLink('driftstack://auth/callback?state=xyz');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('missing-required-param');
    }
  });

  it('rejects missing state', () => {
    const result = parseDeepLink('driftstack://auth/callback?code=abc');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('missing-required-param');
    }
  });

  it('rejects empty-string code', () => {
    const result = parseDeepLink('driftstack://auth/callback?code=&state=xyz');
    expect(result.ok).toBe(false);
  });
});

describe('parseDeepLink — session-open', () => {
  it('parses a session deep-link', () => {
    const result = parseDeepLink('driftstack://session/open?session_id=sess_abc');
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.kind === 'session-open') {
      expect(result.payload.sessionId).toBe('sess_abc');
    }
  });

  it('rejects missing session_id', () => {
    const result = parseDeepLink('driftstack://session/open');
    expect(result.ok).toBe(false);
  });
});

describe('parseDeepLink — recording-open', () => {
  it('parses a recording deep-link', () => {
    const result = parseDeepLink('driftstack://recording/open?recording_id=rec_xyz');
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.kind === 'recording-open') {
      expect(result.payload.recordingId).toBe('rec_xyz');
    }
  });
});

describe('parseDeepLink — profile-import', () => {
  it('parses a profile import deep-link', () => {
    const result = parseDeepLink('driftstack://profile/import?profile_id=prof_123');
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.kind === 'profile-import') {
      expect(result.payload.profileId).toBe('prof_123');
    }
  });
});

describe('parseDeepLink — wrong scheme', () => {
  it('rejects https URLs', () => {
    const result = parseDeepLink('https://example.com/auth/callback?code=x&state=y');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('wrong-scheme');
    }
  });

  it('rejects file URLs', () => {
    const result = parseDeepLink('file:///tmp/foo');
    expect(result.ok).toBe(false);
  });
});

describe('parseDeepLink — malformed URL', () => {
  it('rejects junk strings', () => {
    const result = parseDeepLink('not a url at all');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('malformed-url');
    }
  });

  it('rejects empty string', () => {
    const result = parseDeepLink('');
    expect(result.ok).toBe(false);
  });
});

describe('parseDeepLink — unknown deep-link kinds', () => {
  it('returns kind=unknown for unrecognized hosts (forward-compat)', () => {
    const result = parseDeepLink('driftstack://newkind/foo?bar=baz');
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.kind === 'unknown') {
      expect(result.payload.host).toBe('newkind');
      expect(result.payload.pathname).toBe('/foo');
    }
  });

  it('returns kind=unknown for known host but unknown path', () => {
    const result = parseDeepLink('driftstack://auth/other-flow?x=y');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.kind).toBe('unknown');
    }
  });
});

describe('dispatchDeepLink', () => {
  it('routes cli-authorize URLs to the matching handler', () => {
    const onCliAuthorize = vi.fn();
    const result = dispatchDeepLink('driftstack://auth/callback?code=c&state=s', {
      onCliAuthorize,
    });
    expect(result.dispatched).toBe(true);
    expect(onCliAuthorize).toHaveBeenCalledWith('c', 's');
  });

  it('routes session-open URLs to the matching handler', () => {
    const onSessionOpen = vi.fn();
    const result = dispatchDeepLink('driftstack://session/open?session_id=sess_a', {
      onSessionOpen,
    });
    expect(result.dispatched).toBe(true);
    expect(onSessionOpen).toHaveBeenCalledWith('sess_a');
  });

  it('returns dispatched=false when no matching handler is provided', () => {
    const result = dispatchDeepLink('driftstack://session/open?session_id=sess_a', {});
    expect(result.dispatched).toBe(false);
    expect(result.payload?.kind).toBe('session-open');
  });

  it('returns dispatched=false + null payload on parse error', () => {
    const result = dispatchDeepLink('not a url', {});
    expect(result.dispatched).toBe(false);
    expect(result.payload).toBeNull();
  });

  it('silently drops unknown deep-link kinds', () => {
    const onCliAuthorize = vi.fn();
    const result = dispatchDeepLink('driftstack://newkind/foo', { onCliAuthorize });
    expect(result.dispatched).toBe(false);
    expect(result.payload?.kind).toBe('unknown');
    expect(onCliAuthorize).not.toHaveBeenCalled();
  });
});
