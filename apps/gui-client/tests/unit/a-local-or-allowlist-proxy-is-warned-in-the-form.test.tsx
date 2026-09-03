// The rendered half of a-local-or-allowlist-proxy-is-warned-at-entry.test.ts:
// the proxy form SHOWS the warning beside the field, as the customer types,
// without blocking the save.
//
// Owner: "do not confuse a customer that they could add a local proxy and later
// find out it doesn't work." MEASURED: the form set `validation` only on
// submit/test, and `validateDraft` had nothing to say about a local host or an
// empty credential pair — so the first word about either came from a dead
// session on Driftstack's servers. The form now recomputes `warnings` from the
// live draft and renders them in the same Field slot as the paste hint, amber
// (`text-status-busy`) rather than the error red, because they are advice.
//
// lib/proxies is spread from the REAL module (only I/O is stubbed): a
// hand-listed `validateDraft: () => ({ ok: true, errors: {} })` — the shape the
// other view suites use — would render nothing here and prove nothing.

import { describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as ProxiesModule from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';
import type { ProxyDraft } from '../../src/lib/proxies';

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve()),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve()),
  testProxy: vi.fn(() =>
    Promise.resolve({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 12,
      message: 'ok',
    }),
  ),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve({}),
  saveExitResult: vi.fn(() => Promise.resolve()),
  saveProbeResult: vi.fn(() => Promise.resolve()),
}));

import { ProxyForm } from '../../src/views/ProxiesView';

const BLANK: ProxyDraft = {
  label: '',
  scheme: 'socks5',
  host: '',
  port: 1080,
  username: null,
  password: null,
};

const HOST_WARNING =
  "This proxy is on your own machine or private network. Profiles run on Driftstack's servers, which cannot reach it. Use a proxy with a public address.";
const AUTH_WARNING =
  "This proxy has no username or password. IP-allowlist access won't work: profiles run from Driftstack's servers, not from your IP. Ask your provider for user/pass credentials.";

function hostWarning(): HTMLElement | null {
  return document.querySelector('[data-component="proxy-host-warning"]');
}
function authWarning(): HTMLElement | null {
  return document.querySelector('[data-component="proxy-auth-warning"]');
}

type OnSave = Mock<(d: ProxyDraft) => Promise<void>>;

function mountAddForm(): { onSave: OnSave } {
  const onSave: OnSave = vi.fn((_d: ProxyDraft) => Promise.resolve());
  render(<ProxyForm initial={BLANK} mode="add" onCancel={() => undefined} onSave={onSave} />);
  return { onSave };
}

function typeHost(value: string): void {
  fireEvent.change(screen.getByPlaceholderText('proxy.example.com'), { target: { value } });
}
function typeUsername(value: string): void {
  fireEvent.change(screen.getByLabelText(/^Username \(optional\)/), { target: { value } });
}
function typePassword(value: string): void {
  fireEvent.change(screen.getByLabelText(/^Password \(optional\)/), { target: { value } });
}

describe('a local or allowlist-only proxy is warned about in the form', () => {
  it('CRITICAL VACUITY CONTROL — a public host with a username and password shows NEITHER warning. The arms below assert a warning appears; a form that rendered both unconditionally would satisfy them and fail this.', () => {
    mountAddForm();
    typeHost('proxy.example.com');
    typeUsername('alice');
    typePassword('p4ss');
    expect(hostWarning(), 'a public host drew the host warning').toBeNull();
    expect(authWarning(), 'a credentialed proxy drew the auth warning').toBeNull();
  });

  it('CRITICAL typing a loopback host shows the host warning at once, under the host field, in the advisory amber rather than the error red — no submit, no Test click.', () => {
    mountAddForm();
    typeHost('127.0.0.1');
    const w = hostWarning();
    expect(w, 'no host warning rendered for 127.0.0.1').not.toBeNull();
    expect(w).toHaveTextContent(HOST_WARNING);
    expect(w?.className).toContain('text-status-busy');
    expect(w?.className).not.toContain('text-status-error');
    // Same Field as the host input: the label that wraps the input wraps the note.
    expect(w?.closest('label')?.contains(screen.getByPlaceholderText('proxy.example.com'))).toBe(
      true,
    );
  });

  it('CRITICAL correcting the host to a public address clears the warning — it tracks the draft, not the first keystroke.', () => {
    mountAddForm();
    typeHost('192.168.1.5');
    expect(hostWarning()).not.toBeNull();
    typeHost('proxy.example.com');
    expect(hostWarning(), 'the host warning outlived the private host').toBeNull();
  });

  it('CRITICAL a host with no username and no password shows the auth warning under the password field; adding credentials clears it.', () => {
    mountAddForm();
    typeHost('proxy.example.com');
    const w = authWarning();
    expect(w, 'no auth warning rendered for a credential-less proxy').not.toBeNull();
    expect(w).toHaveTextContent(AUTH_WARNING);
    expect(w?.className).toContain('text-status-busy');
    expect(w?.closest('label')?.contains(screen.getByLabelText(/^Password \(optional\)/))).toBe(
      true,
    );
    typeUsername('alice');
    typePassword('p4ss');
    expect(authWarning(), 'the auth warning outlived the credentials').toBeNull();
  });

  it('CRITICAL a blank form is not warned about. The credentials note is about THE proxy being described, so it waits for a host; a warning on an untouched form is a warning about nothing.', () => {
    mountAddForm();
    expect(authWarning(), 'the auth warning showed before any host was typed').toBeNull();
    expect(hostWarning()).toBeNull();
  });

  it('CRITICAL warnings never block the save. A local, credential-less draft with a label submits and reaches onSave — the limitation is described, not enforced.', async () => {
    const { onSave } = mountAddForm();
    fireEvent.change(screen.getByPlaceholderText('prod-eu-west'), { target: { value: 'home' } });
    typeHost('127.0.0.1');
    expect(hostWarning()).not.toBeNull();
    expect(authWarning()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add proxy' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ host: '127.0.0.1', username: null });
  });
});
