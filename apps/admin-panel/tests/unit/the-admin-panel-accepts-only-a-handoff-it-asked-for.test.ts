// The admin panel accepts only a sign-in handoff it asked for (security sweep #20).
//
// The admin panel has no sign-in of its own: a visit without a session bounces to the
// customer dashboard, which sends the browser back with the session in the URL hash.
// The panel stored WHATEVER `#token=` a URL carried, with no check that it had asked,
// so a crafted `admin.driftstack.io/#token=<other session>` silently replaced a staff
// member's own session (session fixation).
//
// Now the bounce leaves a one-time state in this tab's sessionStorage, the dashboard
// returns it beside the token, and a token is kept only when the two match. The state
// is spent on first read.
//
// The dashboard's "Open admin panel" link used to carry the token itself, so every
// click refreshed the panel's copy. It now asks for a fresh handoff instead
// (`?handoff=1`): the panel drops whatever it holds and runs the handoff above, so a
// copy that sign-out revoked is replaced rather than kept. A crafted link can only
// make the panel re-sync with the visitor's OWN dashboard session.
//
// Runs the pre-paint scripts exactly as AdminLayout and DashboardLayout ship them,
// against stand-ins for the browser objects they touch.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const LAYOUT = resolve(process.cwd(), 'apps/admin-panel/src/layouts/AdminLayout.astro');
const DASHBOARD_LAYOUT = resolve(
  process.cwd(),
  'apps/customer-dashboard/src/layouts/DashboardLayout.astro',
);

class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

interface Visit {
  local: MemoryStorage;
  session: MemoryStorage;
  replacedWith: string[];
  historyUrls: string[];
}

/** Run the admin SSO pre-paint script once, as a page load at `url`. */
function visit(url: string, local = new MemoryStorage(), session = new MemoryStorage()): Visit {
  const source = readFileSync(LAYOUT, 'utf8');
  const match = source.match(/<script is:inline data-admin-sso-preflight>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error('admin SSO preflight script not found');
  const parsed = new URL(url);
  const replacedWith: string[] = [];
  const historyUrls: string[] = [];
  const location = {
    hash: parsed.hash,
    search: parsed.search,
    pathname: parsed.pathname,
    replace: (to: string) => replacedWith.push(to),
  };
  const history = { replaceState: (_s: unknown, _t: string, to: string) => historyUrls.push(to) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('location', 'history', 'localStorage', 'sessionStorage', 'crypto', match[1])(
    location,
    history,
    local,
    session,
    webcrypto,
  );
  return { local, session, replacedWith, historyUrls };
}

/** The dashboard's pre-paint gate, run once at `url` with `token` in its storage;
 *  returns where it sent the browser. */
function dashboard(url: string, token: string | null): string[] {
  const source = readFileSync(DASHBOARD_LAYOUT, 'utf8');
  const marker = source.indexOf('// 2026-05-21 — login gate.');
  const open = source.lastIndexOf('<script is:inline>', marker);
  const close = source.indexOf('</script>', marker);
  if (marker < 0 || open < 0 || close < 0) throw new Error('dashboard login gate not found');
  const parsed = new URL(url);
  const replaced: string[] = [];
  const location = {
    search: parsed.search,
    pathname: parsed.pathname,
    replace: (to: string) => replaced.push(to),
  };
  const localStorage = {
    getItem: (key: string) => (key === 'ds_web_session_token' ? token : null),
  };
  const document = { documentElement: { setAttribute: () => undefined } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    'location',
    'localStorage',
    'document',
    source.slice(open + '<script is:inline>'.length, close),
  )(location, localStorage, document);
  return replaced;
}

/** Where the dashboard's "Open admin panel" link sends the browser, read from its click handler. */
function adminPanelLinkTarget(): string {
  const source = readFileSync(DASHBOARD_LAYOUT, 'utf8');
  const at = source.indexOf("link.addEventListener('click'");
  const match = source.slice(at, at + 400).match(/window\.location\.href = '([^']+)';/);
  if (at < 0 || !match?.[1]) throw new Error('"Open admin panel" click handler not found');
  return match[1];
}

/** Follow the admin ⇄ dashboard hops from `start` until the browser settles on the admin panel. */
function roundTrip(start: string, local: MemoryStorage, dashboardToken: string | null): Visit {
  let url = start;
  let session = new MemoryStorage();
  for (let hop = 0; hop < 6; hop++) {
    const v = visit(url, local, session);
    session = v.session;
    const next = v.replacedWith[0];
    if (next === undefined) return v;
    const [back] = dashboard(next, dashboardToken);
    if (back === undefined) throw new Error(`the dashboard did not send ${next} anywhere`);
    url = back;
  }
  throw new Error('the handoff did not settle');
}

describe('the admin panel accepts only a sign-in handoff it asked for', () => {
  it('CRITICAL a #token= this tab never asked for does not replace the session it holds', () => {
    const local = new MemoryStorage();
    local.setItem('ds_web_session_token', 'STAFF_OWN_SESSION');
    const v = visit('https://admin.driftstack.io/#token=PLANTED_SESSION', local);
    expect(v.local.getItem('ds_web_session_token')).toBe('STAFF_OWN_SESSION');
    // The fragment is still stripped from the address bar.
    expect(v.historyUrls).toEqual(['/']);
  });

  it('CRITICAL a handoff whose state does not match the one this tab left is dropped', () => {
    const session = new MemoryStorage();
    session.setItem('ds_admin_handoff_state', 'a'.repeat(32));
    const v = visit(
      'https://admin.driftstack.io/?bounced=1#token=PLANTED_SESSION&state=' + 'b'.repeat(32),
      new MemoryStorage(),
      session,
    );
    expect(v.local.getItem('ds_web_session_token')).toBeNull();
  });

  it('a visit with no session bounces to the dashboard carrying a fresh one-time state, and the matching return is kept', () => {
    const first = visit('https://admin.driftstack.io/accounts?x=1');
    expect(first.replacedWith).toHaveLength(1);
    const bounce = new URL(first.replacedWith[0] ?? '');
    expect(bounce.origin).toBe('https://app.driftstack.io');
    expect(bounce.searchParams.get('next-admin')).toBe('/accounts?x=1');
    const state = bounce.searchParams.get('admin-state') ?? '';
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(first.session.getItem('ds_admin_handoff_state')).toBe(state);

    const back = visit(
      `https://admin.driftstack.io/accounts?x=1&bounced=1#token=STAFF_SESSION&state=${state}`,
      first.local,
      first.session,
    );
    expect(back.local.getItem('ds_web_session_token')).toBe('STAFF_SESSION');
    expect(back.replacedWith).toEqual([]);
    // Spent: the same state cannot carry a second handoff.
    expect(back.session.getItem('ds_admin_handoff_state')).toBeNull();
  });

  it('CRITICAL the "Open admin panel" link replaces a copy the panel still holds with the dashboard\'s current session', () => {
    // Sign-out revokes the session, and the panel's copy is that same token: after
    // signing out of the dashboard and back in, the panel still holds the old one.
    const local = new MemoryStorage();
    local.setItem('ds_web_session_token', 'REVOKED_OLD');
    const target = adminPanelLinkTarget();
    expect(new URL(target).origin).toBe('https://admin.driftstack.io');
    expect(target).not.toMatch(/token/);
    const settled = roundTrip(target, local, 'FRESH_DASHBOARD');
    expect(settled.local.getItem('ds_web_session_token')).toBe('FRESH_DASHBOARD');
  });

  it("CRITICAL a ?next-admin= visit the admin tab did not start ends holding the dashboard's current session too", () => {
    const local = new MemoryStorage();
    local.setItem('ds_web_session_token', 'REVOKED_OLD');
    const [to] = dashboard('https://app.driftstack.io/?next-admin=%2Faccounts', 'FRESH_DASHBOARD');
    expect(to).not.toContain('FRESH_DASHBOARD');
    const settled = roundTrip(to ?? '', local, 'FRESH_DASHBOARD');
    expect(settled.local.getItem('ds_web_session_token')).toBe('FRESH_DASHBOARD');
    // The hash that carried the token is stripped from the address bar.
    expect(settled.historyUrls).toEqual(['/accounts?bounced=1']);
  });

  it('a fresh-handoff request drops the held copy, bounces with a new state, and does not ask again on the way back', () => {
    const local = new MemoryStorage();
    local.setItem('ds_web_session_token', 'REVOKED_OLD');
    const v = visit('https://admin.driftstack.io/accounts?x=1&handoff=1', local);
    expect(v.local.getItem('ds_web_session_token')).toBeNull();
    expect(v.replacedWith).toHaveLength(1);
    const bounce = new URL(v.replacedWith[0] ?? '');
    expect(bounce.origin).toBe('https://app.driftstack.io');
    expect(bounce.searchParams.get('next-admin')).toBe('/accounts?x=1');
    expect(bounce.searchParams.get('admin-state')).toBe(
      v.session.getItem('ds_admin_handoff_state'),
    );
  });

  it('CONTROL a plain visit with a session in hand keeps it and goes nowhere', () => {
    const local = new MemoryStorage();
    local.setItem('ds_web_session_token', 'STAFF_OWN_SESSION');
    const v = visit('https://admin.driftstack.io/accounts', local);
    expect(v.local.getItem('ds_web_session_token')).toBe('STAFF_OWN_SESSION');
    expect(v.replacedWith).toEqual([]);
  });
});
