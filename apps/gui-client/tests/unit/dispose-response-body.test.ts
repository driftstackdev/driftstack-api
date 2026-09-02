import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { disposeResponseBody } from '../../src/lib/dispose-response-body';

describe('disposeResponseBody', () => {
  it('cancels an unread response stream', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));

    await expect(disposeResponseBody(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not replace the observed HTTP result when cancellation fails', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cleanup failed'));
    const response = { body: { cancel } } as unknown as Response;

    await expect(disposeResponseBody(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('accepts responses without a body', async () => {
    await expect(disposeResponseBody(new Response(null, { status: 204 }))).resolves.toBeUndefined();
  });

  it('guards every direct-fetch status-only exit', () => {
    for (const relative of [
      '../../src/views/SettingsView.tsx',
      '../../src/views/ConnectivityView.tsx',
      '../../src/lib/fleet-members.ts',
      '../../src/lib/use-connection-status.ts',
    ]) {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
      expect(source, relative).toContain('disposeResponseBody');
    }
  });

  it('guards every shared-fetch status-only or stale exit', () => {
    for (const [relative, expectedCalls] of [
      ['../../src/lib/account-proxies.ts', 5],
      ['../../src/lib/account-organization.ts', 2],
      ['../../src/components/SettingsAccountCard.tsx', 2],
      ['../../src/lib/browser-sign-in.ts', 2],
    ] as const) {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
      expect(source.match(/disposeResponseBody\(/g) ?? [], relative).toHaveLength(expectedCalls);
    }
  });
});
