// Regression guard for the ADD half of #27 (089264371). Adding a proxy now probes
// it immediately, so a proxy that cannot route is caught where the customer is
// still looking at it rather than at the first launch through it.
//
// The half that is easy to get wrong is WHICH row gets probed. `refresh()` returns
// void and its setState has not committed by the time the probe is chosen, so
// `state.proxies` inside handleSave is still the PREVIOUS registry and does not
// contain the row that was just added. The code therefore re-lists. If it ever
// goes back to reading component state, the added row is simply never found and
// the probe silently does not happen — a regression with no error, no failing
// call, and no visible symptom until a launch fails.
//
// These arms pin that by giving the REGISTRY row a password the draft never had.
// testProxy is called with the row's fields, so the password is the witness: it
// can only have come from the re-listed registry.
//
// Mock set is deliberately copied from proxies-view-edit-vpn.test.tsx — in
// particular `validateDraft` always-ok, which is what lets `Add proxy` submit
// with an untouched form. A previous attempt at this suite could not get the
// form to submit and was deleted rather than shipped vacuous.

import type * as ProxiesModule from '../../src/lib/proxies';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ProxyConfig, ProxyDraft, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const addProxy = vi.fn<(draft: ProxyDraft) => Promise<unknown>>();
const testProxy = vi.fn<(args: unknown) => Promise<ProxyTestResult>>();

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// EMPTY_DRAFT submits as host:'', port:1080, username:null, password:null — so a
// password on the stored row cannot have come from the draft.
const REGISTRY_ONLY_PASSWORD = 'ONLY_IN_THE_REGISTRY';
const ADDED_ROW: ProxyConfig = {
  id: 'added1',
  label: 'added',
  host: '',
  port: 1080,
  username: null,
  password: REGISTRY_ONLY_PASSWORD,
  createdAt: '2026-08-22T00:00:00.000Z',
  scheme: 'socks5',
};

let stored: ProxyConfig[] = [];
let listProxiesFails = false;

// ⛔ PARTIAL mock, not a replacement. A factory that enumerates exports breaks the
// moment the module gains one — `hostWarningFor` was added for the local-proxy
// advice and seven suites went red on a module they only wanted two stubs from.
// The spread keeps every real export; the keys below still override the ones this
// suite controls.
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  // Real predicate, not a stub — a stub here would let this suite disagree with
  // the app about what "usable" means.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () =>
    listProxiesFails ? Promise.reject(new Error('vault read failed')) : Promise.resolve(stored),
  addProxy: (draft: ProxyDraft) => addProxy(draft),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve()),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (args: unknown) => testProxy(args),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  // Spread the REAL module: this double overrides only the I/O. Stubbing
  // the pure derivation instead would make the arms that depend on it pass
  // vacuously, and a hand-listed factory silently omits every export added
  // later — which is exactly how P-8 broke 18 files at once.
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve({}),
  saveExitResult: vi.fn(() => Promise.resolve()),
  saveProbeResult: vi.fn(() => Promise.resolve()),
}));

const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

const ROUTES = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'Working — CONNECT succeeded.',
};

async function submitTheAddForm(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'New proxy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add proxy' }));
}

describe('adding a proxy probes the row the registry returned, not the draft', () => {
  beforeEach(() => {
    addProxy.mockReset();
    testProxy.mockReset();
    testProxy.mockResolvedValue(ROUTES);
    stored = [];
    listProxiesFails = false;
  });

  it('probes the newly added row, identified from the RE-LISTED registry', async () => {
    // The row does not exist until addProxy resolves — same ordering as the vault.
    addProxy.mockImplementationOnce(() => {
      stored = [ADDED_ROW];
      return Promise.resolve({});
    });
    render(<ProxiesView />);
    await submitTheAddForm();

    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
    // The password is the witness. The draft carried none, so receiving it proves
    // the probe target came from the re-list and not from the submitted form —
    // and reaching this line at all proves it did not come from the stale
    // `state.proxies`, which was empty and would have found no row to probe.
    expect(testProxy).toHaveBeenCalledWith({
      host: '',
      port: 1080,
      username: null,
      password: REGISTRY_ONLY_PASSWORD,
    });
  });

  it('does not probe until the save has actually landed', async () => {
    const pending = deferred<unknown>();
    addProxy.mockReturnValueOnce(pending.promise);
    render(<ProxiesView />);
    await submitTheAddForm();

    await waitFor(() => expect(addProxy).toHaveBeenCalledTimes(1));
    // Mid-save: probing here would test a proxy the vault has not accepted.
    expect(testProxy).not.toHaveBeenCalled();

    stored = [ADDED_ROW];
    pending.resolve({});
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
  });

  // NOTE: the sibling `.catch(() => undefined)` on the probe itself is defensive
  // but unreachable — handleTest owns an internal catch that synthesises a
  // fail-closed result, so it never rejects. Mutating that catch away changes
  // nothing observable, so there is no honest arm to write for it. The REACHABLE
  // break on this path is the re-list, which really can reject: it reads the
  // encrypted vault, and it sits inside the save's try where an unguarded
  // rejection is reported to the customer as a failed save.
  it('a re-list that fails leaves the save reported as the success it was', async () => {
    addProxy.mockImplementationOnce(() => {
      stored = [ADDED_ROW];
      listProxiesFails = true;
      return Promise.resolve({});
    });
    render(<ProxiesView />);
    await submitTheAddForm();

    await waitFor(() => expect(addProxy).toHaveBeenCalledTimes(1));
    // The editor closes, so the save is reported as the success it was...
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add proxy' })).toBeNull());
    // ...and specifically NOT as a failure. A proxy that saved fine reporting
    // "Couldn't save this proxy" is the one outcome this whole path exists to
    // avoid, and a lost `.catch(() => null)` on the re-list produces exactly it.
    expect(screen.queryByText(/Couldn't save this proxy/)).toBeNull();
    // No registry to identify the row from, so no probe — silently, by design.
    expect(testProxy).not.toHaveBeenCalled();
  });
});
