// V-346 — Fleet member registry. CRUD over tauri-plugin-store.
//
// A "fleet member" is a Driftstack control-plane API server the
// founder runs locally on a Mac mini in a fleet (i.e. multiple
// Mac minis, each running an api-server instance + driver, fronted
// by the GUI). Each entry is just a label + base URL; the fleet
// view pings each member's /version on demand to surface status.
//
// Stored under settings.json keyed separately from settings + proxies
// (mirrors the V-244 proxies.ts pattern). Local-only — no server
// round-trip; the founder owns the fleet topology.
//
// IDs are random uuid-shaped strings minted at create time; stable
// across edits for any future "session ran on member X" reference.

import { LazyStore } from '@tauri-apps/plugin-store';
import { disposeResponseBody } from './dispose-response-body';
import { readBoundedDiagnosticJson } from './read-bounded-json';

export interface FleetMember {
  id: string;
  label: string;
  /** e.g. http://10.0.0.5:3000 — same shape as the GUI's primary base URL. */
  baseUrl: string;
  notes: string | null;
  /** ISO8601 created timestamp. Hand-set by the GUI; not server-authoritative. */
  createdAt: string;
}

export interface FleetMemberDraft {
  label: string;
  baseUrl: string;
  notes: string | null;
}

const STORE_FILE = 'settings.json';
const FLEET_KEY = 'fleetMembers';

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

export async function listFleetMembers(): Promise<FleetMember[]> {
  const value = await getStore().get<FleetMember[]>(FLEET_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter(isFleetMember);
}

export async function addFleetMember(draft: FleetMemberDraft): Promise<FleetMember> {
  const all = await listFleetMembers();
  const next: FleetMember = {
    id: mintId(),
    label: draft.label,
    baseUrl: draft.baseUrl.replace(/\/+$/, ''),
    notes: draft.notes,
    createdAt: new Date().toISOString(),
  };
  await persist([...all, next]);
  return next;
}

export async function updateFleetMember(
  id: string,
  patch: FleetMemberDraft,
): Promise<FleetMember | null> {
  const all = await listFleetMembers();
  const idx = all.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const updated: FleetMember = {
    ...(all[idx] as FleetMember),
    label: patch.label,
    baseUrl: patch.baseUrl.replace(/\/+$/, ''),
    notes: patch.notes,
  };
  const next = [...all];
  next[idx] = updated;
  await persist(next);
  return updated;
}

export async function removeFleetMember(id: string): Promise<void> {
  const all = await listFleetMembers();
  await persist(all.filter((m) => m.id !== id));
}

async function persist(members: FleetMember[]): Promise<void> {
  await getStore().set(FLEET_KEY, members);
  await getStore().save();
}

function isFleetMember(v: unknown): v is FleetMember {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.label === 'string' &&
    typeof r.baseUrl === 'string' &&
    (r.notes === null || typeof r.notes === 'string') &&
    typeof r.createdAt === 'string'
  );
}

function mintId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ─── validation helpers ──────────────────────────────────────────

export interface DraftValidation {
  ok: boolean;
  errors: Partial<Record<keyof FleetMemberDraft, string>>;
}

export function validateDraft(d: FleetMemberDraft): DraftValidation {
  const errors: Partial<Record<keyof FleetMemberDraft, string>> = {};
  if (d.label.trim().length === 0) errors.label = 'Required.';
  if (d.baseUrl.trim().length === 0) {
    errors.baseUrl = 'Required.';
  } else {
    try {
      const u = new URL(d.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.baseUrl = 'Must be http:// or https:// URL.';
      }
    } catch {
      errors.baseUrl = 'Invalid URL.';
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// ─── ping helper ─────────────────────────────────────────────────

export interface FleetMemberPing {
  ok: boolean;
  durationMs: number;
  /** From /version on the target. Undefined when ping failed. */
  version?: string;
  driver?: 'mock' | 'webkit' | 'playwright';
  playwrightBrowser?: 'webkit' | 'chromium' | 'firefox';
  /** When ping failed: short human-readable error. */
  error?: string;
}

/**
 * V-346 — fetch /version on the member; resolves with shape suitable
 * for the FleetView. Uses fetch with a 5s timeout via AbortController.
 */
export async function pingFleetMember(member: FleetMember): Promise<FleetMemberPing> {
  const start = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${member.baseUrl}/version`, { signal: ctrl.signal });
    const dur = Math.round(performance.now() - start);
    if (!res.ok) {
      await disposeResponseBody(res);
      return { ok: false, durationMs: dur, error: `HTTP ${res.status.toString()}` };
    }
    const body = await readBoundedDiagnosticJson<{
      version?: unknown;
      driver?: unknown;
      playwright_browser?: unknown;
    }>(res);
    const out: FleetMemberPing = { ok: true, durationMs: dur };
    if (typeof body.version === 'string') out.version = body.version;
    if (body.driver === 'mock' || body.driver === 'webkit' || body.driver === 'playwright') {
      out.driver = body.driver;
    }
    if (
      body.playwright_browser === 'webkit' ||
      body.playwright_browser === 'chromium' ||
      body.playwright_browser === 'firefox'
    ) {
      out.playwrightBrowser = body.playwright_browser;
    }
    return out;
  } catch (err) {
    const dur = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, durationMs: dur, error: message };
  } finally {
    clearTimeout(timer);
  }
}
