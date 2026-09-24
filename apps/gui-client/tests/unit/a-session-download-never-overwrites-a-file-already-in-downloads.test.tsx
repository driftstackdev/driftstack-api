import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TauriCore from '@tauri-apps/api/core';

/**
 * GUI audit #6 — saving a file a website downloaded in a session wrote it to
 * `<Downloads>/<the site's name for it>` with `truncate: true` and never looked
 * first, so a site offering `statement.pdf` silently replaced the customer's own
 * `~/Downloads/statement.pdf`. A save now never overwrites: an existing name gets
 * the ` (1)`, ` (2)` … suffix a browser gives it, and the file is opened
 * create-new, so even a file that appears between the check and the write is
 * never replaced.
 *
 * The Downloads folder is an in-memory stand-in for the fs plugin that honours
 * `createNew` the way the real one does: opening an existing name fails.
 */

const downloads = new Map<string, string>();
const opened: Array<{ name: string; opts: Record<string, unknown> }> = [];
/** Names that appear on disk the instant after `exists` says they are free. */
const appearsAfterCheck = new Set<string>();

// The web-download mark (GUI audit #7) always succeeds here; its own file
// covers it.
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { Download: 7 },
  exists: vi.fn((name: string) => {
    const there = downloads.has(name);
    if (!there && appearsAfterCheck.has(name)) {
      appearsAfterCheck.delete(name);
      downloads.set(name, 'someone else got here first');
    }
    return Promise.resolve(there);
  }),
  open: vi.fn((name: string, opts: Record<string, unknown>) => {
    opened.push({ name, opts });
    if (opts.createNew === true && downloads.has(name)) {
      return Promise.reject(new Error('File exists (os error 17)'));
    }
    if (opts.truncate === true || !downloads.has(name)) downloads.set(name, '');
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
  opened.length = 0;
  appearsAfterCheck.clear();
});
afterEach(() => {
  tauri(false);
});

describe('saving a session download into Downloads', () => {
  it("CRITICAL never replaces the customer's own file of the same name", async () => {
    downloads.set('statement.pdf', 'MY OWN BANK STATEMENT');

    const saved = await downloadResponse('statement.pdf', new Response('website bytes'));

    expect(downloads.get('statement.pdf')).toBe('MY OWN BANK STATEMENT');
    expect(saved).toBe('statement (1).pdf');
    expect(downloads.get('statement (1).pdf')).toBe('website bytes');
    // No open of any name ever asked to truncate an existing file.
    for (const o of opened) expect(o.opts.truncate).not.toBe(true);
  });

  it('CRITICAL keeps counting: the next copy is (2), and a name with no extension gets the suffix at the end', async () => {
    downloads.set('statement.pdf', 'mine');
    downloads.set('statement (1).pdf', 'an earlier download');
    expect(await downloadResponse('statement.pdf', new Response('newest'))).toBe(
      'statement (2).pdf',
    );
    expect(downloads.get('statement (1).pdf')).toBe('an earlier download');

    downloads.set('README', 'mine');
    expect(await downloadResponse('README', new Response('theirs'))).toBe('README (1)');
    expect(downloads.get('README')).toBe('mine');
  });

  it('CRITICAL a file that appears between the check and the write is not replaced either', async () => {
    appearsAfterCheck.add('invoice.zip');
    const saved = await downloadResponse('invoice.zip', new Response('website bytes'));
    expect(downloads.get('invoice.zip')).toBe('someone else got here first');
    expect(saved).toBe('invoice (1).zip');
    expect(downloads.get('invoice (1).zip')).toBe('website bytes');
  });

  it('a free name is saved as-is, and the saved name is reported back', async () => {
    expect(await downloadResponse('report.csv', new Response('a,b\n'))).toBe('report.csv');
    expect(downloads.get('report.csv')).toBe('a,b\n');
  });
});
