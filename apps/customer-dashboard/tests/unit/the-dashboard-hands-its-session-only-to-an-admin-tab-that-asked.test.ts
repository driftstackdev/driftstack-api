// The dashboard hands its session only to an admin tab that asked for it
// (security sweep #20).
//
// The dashboard's pre-paint gate sent ANY signed-in visitor of
// `app.driftstack.io/?next-admin=…` to the admin panel with the session token in the
// URL hash — no click, no check that the panel had asked — and the "Open admin
// panel" link did the same. Now the token travels only beside the one-time state the
// admin tab left for itself (`admin-state`), which the panel checks; without it the
// browser is sent to the admin panel empty-handed and the panel starts its own
// handoff. That trip, and the link, ask the panel for a FRESH handoff (`?handoff=1`),
// so a copy the panel still holds from before a sign-out is replaced, not kept. Runs
// the gate exactly as DashboardLayout ships it, against stand-ins for the browser
// objects it touches.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LAYOUT = resolve(process.cwd(), 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

function gateScript(): string {
  const source = readFileSync(LAYOUT, 'utf8');
  const marker = source.indexOf('// 2026-05-21 — login gate.');
  const open = source.lastIndexOf('<script is:inline>', marker);
  const close = source.indexOf('</script>', marker);
  if (marker < 0 || open < 0 || close < 0) throw new Error('dashboard login gate not found');
  return source.slice(open + '<script is:inline>'.length, close);
}

/** Load a dashboard page at `url` with `token` in storage; returns where it navigated. */
function load(url: string, token: string | null): string[] {
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
  new Function('location', 'localStorage', 'document', gateScript())(
    location,
    localStorage,
    document,
  );
  return replaced;
}

const STATE = '0123456789abcdef0123456789abcdef';

describe('the dashboard hands its session only to an admin tab that asked for it', () => {
  it('CRITICAL a ?next-admin= visit with no admin state is sent to the admin panel WITHOUT the token', () => {
    const [to] = load('https://app.driftstack.io/?next-admin=%2Faccounts', 'MY_SESSION');
    expect(to).toBeDefined();
    const u = new URL(to ?? '');
    expect(u.origin).toBe('https://admin.driftstack.io');
    expect(u.pathname).toBe('/accounts');
    expect(to).not.toContain('MY_SESSION');
    expect(u.hash).toBe('');
    // …and asks the panel to fetch a fresh one rather than keep what it holds.
    expect(u.searchParams.get('handoff')).toBe('1');
  });

  it('the admin tab that asked gets the token beside its own state', () => {
    const [to] = load(
      `https://app.driftstack.io/?next-admin=%2Faccounts&admin-state=${STATE}`,
      'MY_SESSION',
    );
    const u = new URL(to ?? '');
    expect(u.origin).toBe('https://admin.driftstack.io');
    expect(u.searchParams.get('bounced')).toBe('1');
    const handoff = new URLSearchParams(u.hash.slice(1));
    expect(handoff.get('token')).toBe('MY_SESSION');
    expect(handoff.get('state')).toBe(STATE);
  });

  it('a malformed state is not echoed and earns no token; signing in first carries a good one through', () => {
    const [bad] = load(
      'https://app.driftstack.io/?next-admin=%2F&admin-state=%22%3E%3Cx',
      'MY_SESSION',
    );
    expect(bad).not.toContain('MY_SESSION');
    expect(bad).not.toContain('%3Cx');

    const [toLogin] = load(`https://app.driftstack.io/?next-admin=%2F&admin-state=${STATE}`, null);
    const next = new URL(toLogin ?? '', 'https://app.driftstack.io').searchParams.get('next') ?? '';
    expect(next).toBe(`/?next-admin=%2F&admin-state=${STATE}`);
  });

  it('CRITICAL the "Open admin panel" link carries no token: the one place the token is written into a URL is the state-gated handoff', () => {
    const source = readFileSync(LAYOUT, 'utf8');
    expect(source.match(/'#token=' \+/g)).toHaveLength(1);
    expect(source).toMatch(
      /u\.hash = '#token=' \+ encodeURIComponent\(t\) \+ '&state=' \+ adminState;/,
    );
    // The link asks the panel for a fresh handoff instead.
    expect(source).toMatch(
      /window\.location\.href = 'https:\/\/admin\.driftstack\.io\/\?handoff=1';/,
    );
  });

  it('the admin tab that asked is not told to ask again', () => {
    const [to] = load(
      `https://app.driftstack.io/?next-admin=%2Faccounts&admin-state=${STATE}`,
      'MY_SESSION',
    );
    expect(new URL(to ?? '').searchParams.get('handoff')).toBeNull();
  });
});
