// Profile create-templates — night-arc H (profile-create demo fidelity).
//
// The demo's "Save as template / From template" actions: a named preset
// of the create-wizard's fields, stored client-side (own store file, same
// isolation rationale as profiles-meta). Templates are a CONVENIENCE
// layer over the create form — they never touch the server until the
// customer actually creates a profile from one.

import { LazyStore } from '@tauri-apps/plugin-store';

export interface ProfileTemplate {
  /** Display name, unique per store (save overwrites same-name). */
  name: string;
  archetype: string;
  description: string;
  folder: string;
  /** Comma-joined input form, matching the wizard field. */
  tags: string;
  /** Saved epoch ms. */
  savedAt: number;
}

const STORE_FILE = 'profile-templates.json';
const KEY = 'templates';
const MAX_TEMPLATES = 24;
const MAX_NAME = 48;

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

function cleanTemplate(raw: unknown): ProfileTemplate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.trim().length === 0) return null;
  return {
    name: r.name.trim().slice(0, MAX_NAME),
    archetype: typeof r.archetype === 'string' ? r.archetype : '',
    description: typeof r.description === 'string' ? r.description : '',
    folder: typeof r.folder === 'string' ? r.folder : '',
    tags: typeof r.tags === 'string' ? r.tags : '',
    savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
  };
}

export async function loadTemplates(): Promise<ProfileTemplate[]> {
  try {
    const raw = await getStore().get<unknown[]>(KEY);
    if (!Array.isArray(raw)) return [];
    const out: ProfileTemplate[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      const t = cleanTemplate(entry);
      if (t !== null && !seen.has(t.name)) {
        seen.add(t.name);
        out.push(t);
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** Save (same-name overwrites). Caller supplies `savedAt` (Date.now()). */
export async function saveTemplate(t: ProfileTemplate): Promise<ProfileTemplate[]> {
  const clean = cleanTemplate(t);
  if (clean === null) return loadTemplates();
  const all = (await loadTemplates()).filter((x) => x.name !== clean.name);
  all.unshift(clean);
  const capped = all.slice(0, MAX_TEMPLATES);
  await getStore().set(KEY, capped);
  await getStore().save();
  return capped;
}

export async function deleteTemplate(name: string): Promise<ProfileTemplate[]> {
  const all = (await loadTemplates()).filter((x) => x.name !== name);
  await getStore().set(KEY, all);
  await getStore().save();
  return all;
}
