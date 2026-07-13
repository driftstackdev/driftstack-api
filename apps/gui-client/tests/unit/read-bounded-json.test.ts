import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  DIAGNOSTIC_JSON_MAX_BYTES,
  DiagnosticResponseTooLargeError,
  readBoundedDiagnosticJson,
} from '../../src/lib/read-bounded-json';

describe('readBoundedDiagnosticJson', () => {
  it('guards every direct GUI /version diagnostic consumer', () => {
    for (const relative of [
      '../../src/views/ConnectivityView.tsx',
      '../../src/views/SettingsView.tsx',
      '../../src/lib/fleet-members.ts',
      '../../src/lib/use-connection-status.ts',
    ]) {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
      expect(source, relative).toContain('/version`');
      expect(source, relative).toContain('readBoundedDiagnosticJson');
    }
  });

  it('decodes a normal streamed JSON response', async () => {
    const response = new Response(JSON.stringify({ driver: 'webkit', version: 'abc123' }), {
      headers: { 'content-type': 'application/json' },
    });

    await expect(readBoundedDiagnosticJson(response)).resolves.toEqual({
      driver: 'webkit',
      version: 'abc123',
    });
  });

  it('rejects an oversized declared body before pulling and cancels it', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }), {
      headers: { 'content-length': String(DIAGNOSTIC_JSON_MAX_BYTES + 1) },
    });

    await expect(readBoundedDiagnosticJson(response)).rejects.toBeInstanceOf(
      DiagnosticResponseTooLargeError,
    );
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels an unknown-length stream on the first over-cap chunk', async () => {
    const cancel = vi.fn();
    let sent = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return;
          sent = true;
          controller.enqueue(new Uint8Array(DIAGNOSTIC_JSON_MAX_BYTES + 1));
        },
        cancel,
      }),
    );

    await expect(readBoundedDiagnosticJson(response)).rejects.toBeInstanceOf(
      DiagnosticResponseTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('propagates a body-stream AbortError to the caller timeout path', async () => {
    const aborted = new DOMException('timed out', 'AbortError');
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(aborted);
        },
      }),
    );

    await expect(readBoundedDiagnosticJson(response)).rejects.toBe(aborted);
  });

  it('keeps legacy structural test doubles compatible without weakening real Responses', async () => {
    const json = vi.fn().mockResolvedValue({ driver: 'mock' });
    const fake = {
      headers: new Headers(),
      json,
    } as unknown as Response;

    await expect(readBoundedDiagnosticJson(fake)).resolves.toEqual({ driver: 'mock' });
    expect(json).toHaveBeenCalledOnce();
  });
});
