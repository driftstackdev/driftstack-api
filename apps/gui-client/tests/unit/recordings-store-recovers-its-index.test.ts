// `lib/recordings-store.ts` measured 4.1% BRANCH coverage — 47 of 49 uncovered —
// while looking entirely correct on a read. Both facts were true: the code is
// careful, and almost none of it had ever run.
//
// The one test that names this module (`recordings-persist-error`) mocks the
// WHOLE module to test the provider above it, so the store's own paths were
// exercised by nothing. A faithful double hides the real artifact.
//
// What is uncovered is specifically the RECOVERY logic — missing index, corrupt
// index, and a two-direction self-heal against concurrent writes from the
// simulator window and the main window. Recovery paths are where reading is
// weakest evidence, because they only execute once something has already gone
// wrong, and a customer's saved recordings are what they lose if they are wrong.
//
// Mocks the Tauri fs layer rather than the store, following the precedent in
// `log-buffer-crash-trail.test.ts`.

import { describe, expect, it, vi, beforeEach } from 'vitest';

interface Entry {
  name: string;
}
let files: Map<string, string>;
let dirFails: boolean;

const exists = vi.fn((p: string) => Promise.resolve(files.has(p)));
const mkdir = vi.fn(() => Promise.resolve());
const readTextFile = vi.fn((p: string) => {
  const v = files.get(p);
  return v === undefined ? Promise.reject(new Error(`ENOENT ${p}`)) : Promise.resolve(v);
});
const writeTextFile = vi.fn((p: string, body: string) => {
  files.set(p, body);
  return Promise.resolve();
});
const remove = vi.fn((p: string) => {
  files.delete(p);
  return Promise.resolve();
});
const readDir = vi.fn((): Promise<Entry[]> => {
  if (dirFails) return Promise.reject(new Error('EIO'));
  return Promise.resolve(
    [...files.keys()]
      .filter((p) => p.endsWith('.ndjson'))
      .map((p) => ({ name: p.slice(p.lastIndexOf('/') + 1) })),
  );
});

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 'AppData' },
  exists: (...a: unknown[]) => exists(...(a as [string])),
  mkdir: () => mkdir(),
  readDir: () => readDir(),
  readTextFile: (...a: unknown[]) => readTextFile(...(a as [string])),
  remove: (...a: unknown[]) => remove(...(a as [string])),
  writeTextFile: (...a: unknown[]) => writeTextFile(...(a as [string, string])),
}));

const { loadIndex } = await import('../../src/lib/recordings-store');

const INDEX = 'recordings/index.json';
const header = (id: string, startedAt: number): Record<string, unknown> => ({
  id,
  sessionId: `ses_${id}`,
  label: null,
  startedAt,
  endedAt: startedAt + 1000,
  totalCaptured: 1,
  frameCount: 1,
  totalBytes: 10,
});
/** An ndjson file: header line first, then frames. */
const ndjson = (id: string, startedAt = 1000): void => {
  files.set(`recordings/${id}.ndjson`, `${JSON.stringify(header(id, startedAt))}\n`);
};

beforeEach(() => {
  files = new Map();
  dirFails = false;
  vi.clearAllMocks();
});

describe('recordings-store recovers its index', () => {
  it('CRITICAL a MISSING index is rebuilt from the recordings on disk, and the rebuild is persisted. Without this a customer whose index file never got written sees an empty library while every recording is still there.', async () => {
    ndjson('a', 2000);
    ndjson('b', 1000);

    const out = await loadIndex();

    expect(out.map((h) => h.id).sort()).toEqual(['a', 'b']);
    // Rebuilt, not just returned — the next launch must not rescan.
    expect(files.has(INDEX), 'the rebuilt index was written back').toBe(true);
  });

  it('CRITICAL a CORRUPT index falls back to the scan rather than throwing. A JSON parse error here would take out the whole recordings view.', async () => {
    files.set(INDEX, '{ this is not json');
    ndjson('a');

    await expect(loadIndex()).resolves.toEqual([expect.objectContaining({ id: 'a' })]);
  });

  it('an index that parses to a NON-ARRAY is treated as corrupt, not iterated', async () => {
    files.set(INDEX, '{"recordings":[]}');
    ndjson('a');

    await expect(loadIndex()).resolves.toEqual([expect.objectContaining({ id: 'a' })]);
  });

  // ⭐ The two self-heal directions. The source comment explains why both exist:
  // the index update is a read-modify-write on a raw file, so two windows racing
  // can leave it out of sync with disk in EITHER direction.
  it('CRITICAL PRUNES an index entry whose recording file is gone — otherwise it is a permanent ghost card whose Open fails on a missing file', async () => {
    files.set(INDEX, JSON.stringify([header('ghost', 5000), header('real', 1000)]));
    ndjson('real', 1000); // 'ghost' has no ndjson

    const out = await loadIndex();

    expect(out.map((h) => h.id)).toEqual(['real']);
    expect(JSON.parse(files.get(INDEX) ?? '[]'), 'the heal was persisted').toEqual([
      expect.objectContaining({ id: 'real' }),
    ]);
  });

  it('CRITICAL ADDS an on-disk recording missing from the index — a concurrent write dropping the loser must not lose the recording', async () => {
    files.set(INDEX, JSON.stringify([header('known', 1000)]));
    ndjson('known', 1000);
    ndjson('orphan', 3000); // on disk, absent from the index

    const out = await loadIndex();

    expect(out.map((h) => h.id).sort()).toEqual(['known', 'orphan']);
    // Newest first after a heal.
    expect(out[0]?.id).toBe('orphan');
  });

  it('a malformed header line is skipped rather than poisoning the whole rebuild', async () => {
    ndjson('good', 1000);
    files.set('recordings/bad.ndjson', '{"id":"bad"}\n'); // missing required fields

    await expect(loadIndex()).resolves.toEqual([expect.objectContaining({ id: 'good' })]);
  });

  it('CRITICAL a failed directory scan leaves the INDEX view intact rather than emptying it. Returning [] on a transient read error would show a customer an empty library and then rewrite the index to match.', async () => {
    files.set(INDEX, JSON.stringify([header('kept', 1000)]));
    ndjson('kept', 1000);
    dirFails = true;

    const out = await loadIndex();

    expect(out.map((h) => h.id)).toEqual(['kept']);
    expect(JSON.parse(files.get(INDEX) ?? '[]'), 'the index was NOT rewritten').toEqual([
      expect.objectContaining({ id: 'kept' }),
    ]);
  });
});
