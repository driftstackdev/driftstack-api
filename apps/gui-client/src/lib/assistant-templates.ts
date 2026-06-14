// F1 — per-profile AI assistant templates. Named prompt presets the assistant
// panel offers for the selected profile: shipped defaults (e.g. "AI browser
// warming") + user-saved customs. Selecting one seeds the AI-chat composer /
// launches an agent run scoped to that profile_id (reuses AgentChatView +
// useAgentChat({profileId}) + the recipes save path).
//
// Defaults are pure data (testable, no I/O). Customs persist in their own store
// (isolated from settings.json, like proxy-probe-cache / profiles-meta).

import { LazyStore } from '@tauri-apps/plugin-store';

export interface AssistantTemplate {
  id: string;
  label: string;
  /** One-line description shown under the label in the picker. */
  description: string;
  /** The natural-language task seeded into the AI chat for the profile. */
  prompt: string;
  /** true = shipped default, false = user-saved custom. */
  builtin: boolean;
}

// Shipped defaults. Warming presets are deliberately conservative (no logins /
// purchases) so they're safe to run on any profile to age it.
export const DEFAULT_ASSISTANT_TEMPLATES: readonly AssistantTemplate[] = [
  {
    id: 'warm-browse',
    label: 'Warm up — browse',
    description: 'Age the profile by browsing popular sites naturally.',
    prompt:
      'Warm up this profile: visit a handful of popular, reputable websites and browse them naturally — scroll, read, follow a few internal links, pause between pages. Do not log in anywhere, enter any data, or make any purchase.',
    builtin: true,
  },
  {
    id: 'warm-search',
    label: 'Warm up — search',
    description: 'Run a few realistic searches and read results.',
    prompt:
      'Warm up this profile by running a few realistic web searches on everyday topics, opening a couple of results for each, and reading them for a little while before moving on. No logins, no forms, no purchases.',
    builtin: true,
  },
  {
    id: 'open-screenshot',
    label: 'Open & screenshot',
    description: 'Navigate to a site and capture the page.',
    prompt: 'Open example.com and take a screenshot of the page.',
    builtin: true,
  },
  {
    id: 'add-to-cart',
    label: 'Add to cart (stop before paying)',
    description: 'Shop a product into the cart — never checks out.',
    prompt:
      'Go to a product page on a shopping site, add a few items to the cart, and stop before entering any payment details or placing the order.',
    builtin: true,
  },
];

const STORE_FILE = 'assistant-templates.json';
const KEY = 'templates';
const MAX_CUSTOM = 50;

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) store = new LazyStore(STORE_FILE);
  return store;
}

/** Validate + normalise a persisted custom template; null if malformed. */
export function cleanCustomTemplate(raw: unknown): AssistantTemplate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    r.id.length === 0 ||
    typeof r.label !== 'string' ||
    typeof r.prompt !== 'string' ||
    r.prompt.trim().length === 0
  ) {
    return null;
  }
  return {
    id: r.id,
    label: r.label.slice(0, 80),
    description: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
    prompt: r.prompt,
    builtin: false,
  };
}

export async function loadCustomTemplates(): Promise<AssistantTemplate[]> {
  try {
    const raw = await getStore().get<unknown>(KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map(cleanCustomTemplate).filter((t): t is AssistantTemplate => t !== null);
  } catch {
    return [];
  }
}

export async function saveCustomTemplate(
  t: Omit<AssistantTemplate, 'builtin'>,
): Promise<AssistantTemplate[]> {
  const all = await loadCustomTemplates();
  const entry: AssistantTemplate = { ...t, builtin: false };
  const idx = all.findIndex((x) => x.id === entry.id);
  const next = idx >= 0 ? all.map((x, i) => (i === idx ? entry : x)) : [...all, entry];
  const capped = next.slice(-MAX_CUSTOM);
  await getStore().set(KEY, capped);
  await getStore().save();
  return capped;
}

export async function deleteCustomTemplate(id: string): Promise<AssistantTemplate[]> {
  const all = await loadCustomTemplates();
  const next = all.filter((t) => t.id !== id);
  await getStore().set(KEY, next);
  await getStore().save();
  return next;
}

/** Defaults first, then customs — the full ordered list for the picker. */
export function mergeTemplates(customs: ReadonlyArray<AssistantTemplate>): AssistantTemplate[] {
  return [...DEFAULT_ASSISTANT_TEMPLATES, ...customs];
}
