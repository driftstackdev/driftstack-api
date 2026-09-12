// (P1, owner 2026-09-12) — deleting a proxy must DETACH it from its profiles,
// never hand them to another one.
//
// Owner, verbatim: "when a proxy is removed, and it still has existing profiles
// on tha proxy, currnently it siwtches to another proxy which is availalbe, i
// think it would be better, if proxy was simply removed".
//
// ⛔ This file replaces proxies-view-delete-clears-bindings.test.tsx, which
// pinned the step that CAUSED the re-point: the delete nulled every binding
// naming the proxy, and a null default means "never chose one" to all three
// resolvers, which then return `proxies[0]`. The mechanism and the resolver
// consequence are pinned in profile-bindings.test.ts; what this file pins is
// the VIEW's half — it reads the bindings, it counts them in the confirm
// BEFORE anything is destroyed, and it never writes one.
//
// ⛔ THE FIXTURE HAS TWO PROXIES, deliberately. With one, "it switches to
// another proxy which is available" is INEXPRESSIBLE: there is no other proxy
// to switch to, so `setDefaultProxy` being uncalled pins "writes no binding"
// and not "re-points nothing". A re-point written the way anyone would write it
// (`const survivor = state.proxies.find((p) => p.id !== id)`) passed the
// single-proxy version of this file.
//
// The second thing two proxies make expressible is the INHERITING profile. P1
// detaches the profiles a binding names; a profile that never chose one
// inherits `proxies[0]`, so removing the FIRST saved proxy silently moves every
// such profile to the next one — the owner's hazard, for profiles no binding
// names. The dialog may not print "Nothing is moved to a different proxy" then,
// and the arms below pin both directions of that.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ProxyConfig } from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const removeProxy = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
const profilesUsingProxy = vi.fn<(id: string) => Promise<string[]>>(() => Promise.resolve([]));
// The one other way this view could write a binding. Pinned as NEVER called:
// a future "helpfully move them to the remaining proxy" is exactly the defect.
const setDefaultProxy = vi.fn<(profileId: string, proxyId: string | null) => Promise<void>>(() =>
  Promise.resolve(),
);

// handleRemove is gated behind a useConfirm() danger dialog. The mock
// auto-resolves true so the delete proceeds, and records the message plus how
// much destruction had already happened when it was asked — the count has to be
// in the question, which means it has to be read before the removal.
const confirmCalls: Array<{ message: string; removedSoFar: number }> = [];
let confirmAnswer = true;
const confirmFn = vi.fn<(msg: string, opts?: unknown) => Promise<boolean>>((msg: string) => {
  confirmCalls.push({ message: msg, removedSoFar: removeProxy.mock.calls.length });
  return Promise.resolve(confirmAnswer);
});
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => confirmFn,
}));

let stored: ProxyConfig[] = [];

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: (id: string) => removeProxy(id),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() =>
    // A launch-path stub must model a proxy that ROUTES, not merely one that
    // answers. The pre-launch gate re-tests and refuses anything unusable, so a
    // bare { reachable: true } now blocks every launch these suites assert.
    Promise.resolve({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 12,
      message: 'Working — CONNECT succeeded.',
    }),
  ),
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

vi.mock('../../src/lib/profile-bindings', () => ({
  profilesUsingProxy: (id: string) => profilesUsingProxy(id),
  setDefaultProxy: (profileId: string, proxyId: string | null) =>
    setDefaultProxy(profileId, proxyId),
}));

// ProxiesView reads useSettings() (to delete the server-side account_proxies row
// on remove). With apiKey:null the server delete is skipped — the local CRUD +
// binding path under test is unaffected. Stable object → useEffect-dep safe.
const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

/** The HEAD of the saved list — the proxy every profile that never chose one
 *  inherits (`ProfilesView.pickProxy` → `proxies[0]`). */
const HEAD: ProxyConfig = {
  id: 'px_us',
  label: 'us-east',
  host: 'us.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-19T00:00:00.000Z',
};

const PROXY: ProxyConfig = {
  id: 'px_eu',
  label: 'eu-west',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
};

function rowOf(label: string): HTMLElement {
  const tr = screen.getByText(label).closest('tr');
  if (tr === null) throw new Error(`no row rendered for ${label}`);
  return tr;
}

/** Remove ONE named row. Scoped to its own row: with two proxies there are two
 *  Remove buttons, and an unscoped getByRole would throw (or worse, pick the
 *  other proxy and quietly assert about the wrong delete). */
async function clickRemove(label = 'eu-west'): Promise<void> {
  await screen.findByText(label);
  fireEvent.click(within(rowOf(label)).getByRole('button', { name: 'Remove' }));
}

/** Select rows by their checkboxes and use the bulk action. */
async function clickRemoveSelected(labels: string[]): Promise<void> {
  await screen.findByText(labels[0] ?? '');
  for (const label of labels) {
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${label}` }));
  }
  fireEvent.click(await screen.findByRole('button', { name: 'Remove selected' }));
}

describe('ProxiesView — deleting a proxy detaches it from its profiles', () => {
  beforeEach(() => {
    removeProxy.mockClear();
    removeProxy.mockImplementation(() => Promise.resolve());
    setDefaultProxy.mockClear();
    confirmFn.mockClear();
    confirmCalls.length = 0;
    confirmAnswer = true;
    profilesUsingProxy.mockReset();
    profilesUsingProxy.mockResolvedValue([]);
    // HEAD first: removing 'eu-west' is therefore NOT a removal of the
    // inherited default, which is the configuration most arms below want.
    stored = [HEAD, PROXY];
  });

  it('reads which profiles use the proxy, by its id', async () => {
    render(<ProxiesView />);
    await clickRemove();
    await waitFor(() => expect(removeProxy).toHaveBeenCalledWith('px_eu'));
    expect(profilesUsingProxy).toHaveBeenCalledWith('px_eu');
    // …and only about the proxy being removed.
    expect(profilesUsingProxy).not.toHaveBeenCalledWith('px_us');
  });

  it('CRITICAL the confirm states the COUNT, and states it before anything is removed', async () => {
    profilesUsingProxy.mockResolvedValue(['prof_a', 'prof_b']);
    render(<ProxiesView />);
    await clickRemove();
    await waitFor(() => expect(confirmCalls.length).toBe(1));

    const asked = confirmCalls[0];
    expect(asked?.message).toContain('2 profiles using it will be left with no proxy');
    // …and it also says what does NOT happen, because the old behaviour did.
    expect(asked?.message).toContain('Nothing is moved to a different proxy');
    // The question was asked while the proxy was still there: a count derived
    // after the removal is a count of nothing.
    expect(asked?.removedSoFar).toBe(0);
  });

  it('CRITICAL re-points nothing — no binding is written at all, and never to the surviving proxy', async () => {
    profilesUsingProxy.mockResolvedValue(['prof_a', 'prof_b']);
    render(<ProxiesView />);
    await clickRemove();
    // ⛔ WAIT FOR THE HANDLER'S END STATE, not merely for the removal. The
    // notice is the LAST thing handleRemove does, so by the time it is on
    // screen every awaited step in the handler has run. Taking this negative
    // straight after `removeProxy` was called let an awaited re-point placed
    // LATER in the same handler slip past: MEASURED — a re-point inserted
    // after `await refresh()` left this arm GREEN while a different arm went
    // red. A negative assertion is only as strong as the moment it is taken.
    await waitFor(() => expect(screen.getByText(/2 profiles were using this proxy/i)).toBeTruthy());
    // The profiles keep naming the deleted proxy, which every resolver reads as
    // "no proxy" (profile-bindings.test.ts). Writing a binding here — to null,
    // or to the surviving proxy — is what leaked a different country.
    expect(setDefaultProxy).not.toHaveBeenCalled();
    // Stated the other way too, so the arm still speaks when the bare negative
    // above is ever relaxed: the survivor is named, and it is never written.
    expect(setDefaultProxy).not.toHaveBeenCalledWith(expect.anything(), 'px_us');
  });

  it('CRITICAL removing the INHERITED default says where those profiles go — it does not promise "nothing is moved"', async () => {
    // No binding names 'us-east'; it is simply first, which is what every
    // profile that never chose a proxy resolves to. Removing it moves them all
    // to 'eu-west', and the dialog that denied that was denying the owner's own
    // complaint in the one case it still happens.
    profilesUsingProxy.mockResolvedValue([]);
    render(<ProxiesView />);
    await clickRemove('us-east');
    await waitFor(() => expect(confirmCalls.length).toBe(1));

    const asked = confirmCalls[0];
    expect(asked?.message).toContain('profiles that never chose one will use "eu-west" instead');
    expect(asked?.message).not.toContain('Nothing is moved to a different proxy');
  });

  it('CRITICAL … and says it in the BOUND-profile sentence too, not only the "no profile" one', async () => {
    // Two separate branches can name the inherited proxy: the `affected === 0`
    // sentence (arm above) and the one that reports a count. MEASURED: a
    // mutation that flattened only the second read GREEN against the arm
    // above, because that arm exercises the first. Both are pinned.
    profilesUsingProxy.mockResolvedValue(['prof_a', 'prof_b']);
    render(<ProxiesView />);
    await clickRemove('us-east');
    await waitFor(() => expect(confirmCalls.length).toBe(1));

    const asked = confirmCalls[0];
    expect(asked?.message).toContain('2 profiles using it will be left with no proxy');
    expect(asked?.message).toContain(
      'Profiles that never chose a proxy will use "eu-west" instead',
    );
    expect(asked?.message).not.toContain('Nothing is moved to a different proxy');
  });

  it('the named proxy is the SURVIVOR, not just any other row — removing them all leaves nothing to inherit', async () => {
    // Removing BOTH includes the head, so the head-is-going test is satisfied —
    // but nothing survives to inherit, so the promise is true again and no
    // proxy may be named. The sentence tracks the surviving list, not the mere
    // presence of a peer row. (1 affected, so the promise clause is printed at
    // all: the `affected === 0` branch deliberately carries no such clause.)
    profilesUsingProxy.mockImplementation((id: string) =>
      Promise.resolve(id === 'px_us' ? ['prof_a'] : []),
    );
    render(<ProxiesView />);
    await clickRemoveSelected(['us-east', 'eu-west']);
    await waitFor(() => expect(confirmCalls.length).toBe(1));
    expect(confirmCalls[0]?.message).toContain('Nothing is moved to a different proxy');
    expect(confirmCalls[0]?.message).not.toContain('will use');
  });

  it('surfaces a notice naming how many profiles now have no proxy', async () => {
    profilesUsingProxy.mockResolvedValue(['prof_a', 'prof_b']);
    render(<ProxiesView />);
    await clickRemove();
    await waitFor(() => expect(screen.getByText(/2 profiles were using this proxy/i)).toBeTruthy());
    expect(screen.getByText(/they now have no proxy/i)).toBeTruthy();
  });

  it('says nothing about profiles when none was using the proxy', async () => {
    profilesUsingProxy.mockResolvedValue([]);
    render(<ProxiesView />);
    await clickRemove();
    await waitFor(() => expect(removeProxy).toHaveBeenCalled());
    expect(confirmCalls[0]?.message).toContain('No profile is using it as its default');
    expect(screen.queryByText(/were using this proxy/i)).toBeNull();
  });

  it('CRITICAL a binding store it cannot read HEDGES — it never claims "no profile is using it"', async () => {
    // A failed read that degrades to 0 prints a reassurance over a destructive
    // action. The one sentence here that must never be a guess.
    profilesUsingProxy.mockRejectedValue(new Error('binding store offline'));
    render(<ProxiesView />);
    await clickRemove();
    await waitFor(() => expect(confirmCalls.length).toBe(1));
    expect(confirmCalls[0]?.message).toContain('Any profile using it as its default');
    expect(confirmCalls[0]?.message).not.toContain('No profile is using it');
    // The removal still proceeds on a confirmed intent, and still writes no
    // binding — the read failure costs the count, not the honesty.
    await waitFor(() => expect(removeProxy).toHaveBeenCalledWith('px_eu'));
    expect(setDefaultProxy).not.toHaveBeenCalled();
    expect(screen.queryByText(/now have no proxy/i)).toBeNull();
  });

  it('a declined confirm removes nothing and reads no bindings twice', async () => {
    confirmAnswer = false;
    profilesUsingProxy.mockResolvedValue(['prof_a']);
    render(<ProxiesView />);
    await clickRemove();
    await waitFor(() => expect(confirmCalls.length).toBe(1));
    expect(removeProxy).not.toHaveBeenCalled();
    expect(setDefaultProxy).not.toHaveBeenCalled();
    expect(profilesUsingProxy).toHaveBeenCalledTimes(1);
  });

  // ── the bulk path: the one with the union rule, and the one whose confirm
  //    was unguarded (a mutation that always printed "No profile is using
  //    them" over a selection that strands profiles passed the whole suite) ──

  it('CRITICAL the bulk confirm states the UNIONED count, and counts a doubly-bound profile once', async () => {
    // prof_a is the default of BOTH removed proxies. It is ONE profile left
    // without a proxy, not two — and 'their', not 'its', over a plural subject.
    profilesUsingProxy.mockImplementation((id: string) =>
      Promise.resolve(id === 'px_us' ? ['prof_a'] : ['prof_a', 'prof_b']),
    );
    render(<ProxiesView />);
    await clickRemoveSelected(['us-east', 'eu-west']);
    await waitFor(() => expect(confirmCalls.length).toBe(1));

    const asked = confirmCalls[0];
    expect(asked?.message).toContain('Remove 2 proxies?');
    expect(asked?.message).toContain('2 profiles using them will be left with no proxy');
    expect(asked?.message).not.toContain('3 profiles using them');
    // Asked before any destruction, exactly as the single-row path is.
    expect(asked?.removedSoFar).toBe(0);
  });

  it('the bulk confirm is grammatical over a plural subject ("their", not "its")', async () => {
    profilesUsingProxy.mockResolvedValue([]);
    render(<ProxiesView />);
    await clickRemoveSelected(['us-east', 'eu-west']);
    await waitFor(() => expect(confirmCalls.length).toBe(1));
    expect(confirmCalls[0]?.message).toContain('No profile is using them as their default');
    expect(confirmCalls[0]?.message).not.toContain('as its default');
  });

  it('CRITICAL a PARTIAL bulk failure claims only the proxies that actually went', async () => {
    // 'us-east' cannot be removed; its profile still has it. Claiming both
    // proxies' profiles "now have no proxy" is a false statement about a
    // profile whose proxy is still on screen.
    profilesUsingProxy.mockImplementation((id: string) =>
      Promise.resolve(id === 'px_us' ? ['prof_a'] : ['prof_b']),
    );
    removeProxy.mockImplementation((id: string) =>
      id === 'px_us' ? Promise.reject(new Error('nope')) : Promise.resolve(),
    );
    render(<ProxiesView />);
    await clickRemoveSelected(['us-east', 'eu-west']);

    await waitFor(() => expect(removeProxy).toHaveBeenCalledWith('px_eu'));
    await waitFor(() => expect(screen.getByText(/1 of 2 could not be removed/i)).toBeTruthy());
    expect(screen.getByText(/1 profile was using this proxy/i)).toBeTruthy();
    expect(screen.queryByText(/2 profiles were using/i)).toBeNull();
    expect(setDefaultProxy).not.toHaveBeenCalled();
  });

  it('a bulk removal where EVERY remove fails claims no detach at all', async () => {
    profilesUsingProxy.mockResolvedValue(['prof_a']);
    removeProxy.mockImplementation(() => Promise.reject(new Error('nope')));
    render(<ProxiesView />);
    await clickRemoveSelected(['us-east', 'eu-west']);
    await waitFor(() => expect(screen.getByText(/None could be removed/i)).toBeTruthy());
    expect(screen.queryByText(/now ha(s|ve) no proxy/i)).toBeNull();
  });
});
