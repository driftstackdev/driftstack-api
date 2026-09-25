// Found while reading the owner's developer logs (item 8, 2026-09-24): the
// video library logs its signalling URL at INFO — `wss://…/rtc/v1?access_token=
// <JWT>&join_request=…` — and the log capture wrote it, token and all, into
// recordings/dev-log-simulator.txt on disk. The developer log keeps hosts,
// paths and stack frames; it must never keep a secret VALUE.

import { beforeEach, describe, expect, it } from 'vitest';
import { clearLogEntries, getLogEntries, record, redactSecrets } from '../../src/lib/log-buffer';

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJ2aWRlbyI6eyJyb29tIjoiYWd0XzUwZiJ9LCJzdWIiOiJjdXN0b21lciJ9.c2lnbmF0dXJlLXN0cmluZw';

beforeEach(() => {
  clearLogEntries();
});

describe('the developer log never keeps a join token', () => {
  it('CRITICAL the signalling URL line is kept, its access_token value is not', () => {
    record('info', [
      `signal connecting to wss://sfu-us-001.driftstack.dev/rtc/v1?access_token=${JWT}&join_request=CAESswsf&auto_subscribe=1`,
    ]);
    const text = getLogEntries().at(-1)?.text ?? '';
    expect(text).not.toContain(JWT);
    expect(text).toContain('access_token=[redacted]');
    // The useful part of the line survives.
    expect(text).toContain('wss://sfu-us-001.driftstack.dev/rtc/v1?');
    expect(text).toContain('auto_subscribe=1');
  });

  it('redacts bearer values, URL passwords and account keys; leaves ordinary text alone', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactSecrets('socks5://user:hunter2@203.0.113.9:1080')).toBe(
      'socks5://[redacted]@203.0.113.9:1080',
    );
    expect(redactSecrets('key ds_live_a91f0c3e7c55b2 saved')).toBe('key ds_live_[redacted] saved');
    const plain = '[api] GET https://api.driftstack.dev/v1/profiles?limit=50 → 404 Not Found';
    expect(redactSecrets(plain)).toBe(plain);
  });
});
