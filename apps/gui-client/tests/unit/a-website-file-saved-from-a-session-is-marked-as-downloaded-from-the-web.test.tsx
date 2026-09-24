import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TauriCore from '@tauri-apps/api/core';

/**
 * GUI audit #7 — a file a website downloaded in a session was written to
 * Downloads like any file the app made: no quarantine mark, so macOS never
 * checked an app inside a downloaded archive and it opened with no Gatekeeper
 * warning, where a browser download would have warned. The save now asks the
 * native side to mark the SAVED file as a web download (`mark_session_download`
 * — the macOS arm is proved in Rust, `a_session_download_carries_the_web_
 * download_quarantine_mark`), and a file that cannot be marked is not kept.
 */

const downloads = new Map<string, string>();
const invokeCalls: Array<{ cmd: string; args: unknown; fileThen: string | undefined }> = [];
let markFails = false;

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  invoke: vi.fn((cmd: string, args?: { name?: string }) => {
    invokeCalls.push({ cmd, args, fileThen: downloads.get(args?.name ?? '') });
    if (cmd === 'mark_session_download' && markFails) {
      return Promise.reject(new Error('quarantine could not be set'));
    }
    return Promise.resolve(undefined);
  }),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { Download: 7 },
  exists: vi.fn((name: string) => Promise.resolve(downloads.has(name))),
  open: vi.fn((name: string, opts: { createNew?: boolean }) => {
    if (opts.createNew === true && downloads.has(name)) {
      return Promise.reject(new Error('File exists (os error 17)'));
    }
    downloads.set(name, '');
    const decoder = new TextDecoder();
    return Promise.resolve({
      write: (bytes: Uint8Array): Promise<number> => {
        downloads.set(name, (downloads.get(name) ?? '') + decoder.decode(bytes));
        return Promise.resolve(bytes.byteLength);
      },
      close: (): Promise<void> => Promise.resolve(),
    });
  }),
  remove: vi.fn((name: string) => {
    downloads.delete(name);
    return Promise.resolve();
  }),
  writeFile: vi.fn(),
}));

const { downloadResponse } = await import('../../src/lib/download');

function tauri(on: boolean): void {
  (globalThis as unknown as { isTauri?: boolean }).isTauri = on || undefined;
}

beforeEach(() => {
  tauri(true);
  downloads.clear();
  invokeCalls.length = 0;
  markFails = false;
});
afterEach(() => {
  tauri(false);
});

describe("a website's file saved from a session", () => {
  it('CRITICAL is marked as downloaded from the web, once it is completely written', async () => {
    const saved = await downloadResponse('invoice.zip', new Response('website bytes'));
    expect(saved).toBe('invoice.zip');
    const marks = invokeCalls.filter((c) => c.cmd === 'mark_session_download');
    expect(marks).toEqual([
      { cmd: 'mark_session_download', args: { name: 'invoice.zip' }, fileThen: 'website bytes' },
    ]);
  });

  it('CRITICAL the mark goes on the name it was SAVED under, not the one the site asked for', async () => {
    downloads.set('invoice.zip', 'mine');
    expect(await downloadResponse('invoice.zip', new Response('website bytes'))).toBe(
      'invoice (1).zip',
    );
    expect(invokeCalls.filter((c) => c.cmd === 'mark_session_download').map((c) => c.args)).toEqual(
      [{ name: 'invoice (1).zip' }],
    );
  });

  it('CRITICAL a file that cannot be marked is not kept, and the save reports failure', async () => {
    markFails = true;
    expect(await downloadResponse('invoice.zip', new Response('website bytes'))).toBeNull();
    expect(downloads.has('invoice.zip')).toBe(false);
  });
});
