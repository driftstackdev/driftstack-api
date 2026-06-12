// profile-templates — save/load round-trip, same-name overwrite, cap,
// corrupt-entry degrade. Store mocked (plugin-store pattern).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();

vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private file: string;
    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }
    private map(): Map<string, unknown> {
      let m = stores.get(this.file);
      if (!m) {
        m = new Map();
        stores.set(this.file, m);
      }
      return m;
    }
    get(key: string): Promise<unknown> {
      return Promise.resolve(this.map().get(key));
    }
    set(key: string, value: unknown): Promise<void> {
      this.map().set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { deleteTemplate, loadTemplates, saveTemplate } from '../../src/lib/profile-templates';

const T = (name: string, savedAt: number) => ({
  name,
  archetype: 'iphone17_ios18_7_safari26_4',
  description: 'd',
  folder: 'F',
  tags: 'a, b',
  savedAt,
});

describe('profile-templates', () => {
  beforeEach(() => {
    stores.clear();
  });

  it('round-trips and sorts newest-first', async () => {
    await saveTemplate(T('old', 1));
    await saveTemplate(T('new', 2));
    const all = await loadTemplates();
    expect(all.map((t) => t.name)).toEqual(['new', 'old']);
    expect(all[0]).toEqual(T('new', 2));
  });

  it('same-name save overwrites (no duplicates)', async () => {
    await saveTemplate(T('x', 1));
    await saveTemplate({ ...T('x', 2), folder: 'G' });
    const all = await loadTemplates();
    expect(all).toHaveLength(1);
    expect(all[0]?.folder).toBe('G');
  });

  it('caps at 24 templates (oldest dropped)', async () => {
    for (let i = 0; i < 30; i++) await saveTemplate(T(`t${String(i)}`, i));
    const all = await loadTemplates();
    expect(all).toHaveLength(24);
    expect(all[0]?.name).toBe('t29');
  });

  it('corrupt entries degrade to absent; nameless rejected; delete removes', async () => {
    await saveTemplate(T('keep', 1));
    const m = stores.get('profile-templates.json');
    const arr = (m?.get('templates') ?? []) as unknown[];
    m?.set('templates', [...arr, 'garbage', { archetype: 'no-name' }, { name: '   ' }]);
    let all = await loadTemplates();
    expect(all.map((t) => t.name)).toEqual(['keep']);
    all = await deleteTemplate('keep');
    expect(all).toHaveLength(0);
  });
});
