// An AGED capability reading reaches the profile card and the profiles list.
//
// MEASURED (2026-09-17): the cache derivation gained a parallel `aged` structure —
// a reading that left its present-tense map after thirty minutes is still
// offered, dated, so a chip can say "✓ QUIC · 4 h ago" instead of pretending
// nothing was ever measured — and in the same change the Test's relay reading
// (`quicProbe`) began to age like its siblings. The Proxies tab was handed the
// new props. The two PROFILE surfaces were not, so on them a relay reading older
// than thirty minutes (and every one saved before relay readings were dated at
// all) fell back to "QUIC ~ … not yet tested. Run Test", and the list's OS chip
// simply vanished: "information goes missing", reintroduced one page over.
//
// Four arms per surface, through the REAL ProfilesView so the wiring is what is
// under test (the components would pass with a parent that never feeds them):
//   (a) 31 minutes old  → the aged, past-tense chip with its age — PRINTED where
//       the row has the room (the list always; the card's tile from the width at
//       which every aged chip fits dated), and otherwise still in the chip's text
//       for a reader that gets no chrome, in a chrome no current chip wears;
//   (b) NO stamp        → unmeasured, honestly — never current, never aged;
//   (c) fresh           → byte-for-byte what it rendered before this existed;
//   (d) never measured  → the unmeasured chip (the control for (a): without it
//       (a) would pass on a surface that calls everything aged).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as ProxiesModule from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type { OsFingerprint } from '../../src/lib/os-fingerprint-verdict';
import type { CachedOsFingerprint } from '../../src/lib/proxy-probe-cache';
import {
  capabilityChips,
  ProfilePhoneCard,
  visibleChips,
  type CapsInput,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import {
  ProfilesTable,
  type ProfileTableRow,
  type ProfilesTableProps,
} from '../../src/components/ProfilesTable';

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

function profile(n: 1 | 2 = 1) {
  return {
    id: `prof_${n.toString()}`,
    name: n === 1 ? 'Demo' : 'Second',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    description: null,
    last_used_at: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
  };
}

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () =>
          Promise.resolve({ data: proxyRef.second ? [profile(), profile(2)] : [profile()] }),
        // eslint-disable-next-line @typescript-eslint/require-await
        iterate: async function* () {
          yield profile();
          if (proxyRef.second) yield profile(2);
        },
      },
      sessions: { list: () => Promise.resolve({ data: [] }), create: vi.fn() },
      agentSessions: {
        create: vi.fn(),
        close: vi.fn(() => Promise.resolve({})),
        livekitToken: vi.fn(),
        list: () => Promise.resolve({ data: [] }),
      },
    },
    settings: {
      apiKey: 'ds_test_x',
      baseUrl: 'http://localhost:3000',
      startUrl: 'https://driftstack.io',
    },
    accountMe: {
      tier: 'solo_manual',
      concurrent_session_cap: 1,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_active: 1,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  };
  return { useSettings: () => stable };
});

vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () =>
    Promise.resolve([
      { profileId: 'prof_1', defaultProxyId: 'p1', currentSessionId: null, lastLaunchedAt: null },
      ...(proxyRef.second
        ? [
            {
              profileId: 'prof_2',
              defaultProxyId: 'p2',
              currentSessionId: null,
              lastLaunchedAt: null,
            },
          ]
        : []),
    ]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

const UDP_OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};

// `serverId` is what makes the row one the automatic check would really take —
// a row never saved to the account is never sent, so its chip must not promise.
// `second` adds a SECOND profile bound to a second proxy that IS saved to the
// account: the row the planner really will recheck, whose promise is the positive
// signal that the ledger read has landed (see the "promises nothing" arms).
const { proxyRef } = vi.hoisted(() => {
  const ref: { serverId: string | undefined; second: boolean } = {
    serverId: 'aprx_1',
    second: false,
  };
  return { proxyRef: ref };
});
function proxy(n: 1 | 2 = 1): ProxyConfig {
  const serverId = n === 1 ? proxyRef.serverId : 'aprx_2';
  return {
    id: `p${n.toString()}`,
    label: n === 1 ? 'london-socks' : 'paris-socks',
    host: n === 1 ? 'proxy.example.com' : 'proxy2.example.com',
    port: 1080,
    username: 'u',
    password: 'p',
    createdAt: '2026-05-20T00:00:00.000Z',
    scheme: 'socks5',
    ...(serverId !== undefined ? { serverId } : {}),
  };
}

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve(proxyRef.second ? [proxy(), proxy(2)] : [proxy()]),
  addProxy: vi.fn(),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  testProxy: vi.fn(() => Promise.resolve(UDP_OK)),
  probeProxyExit: () => Promise.resolve(null),
}));
// Partial mock: the cache imports `cleanMeasuredQuic` from here.
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/open-simulator', () => ({
  openSimulatorWindow: vi.fn(() => Promise.resolve({ opened: true })),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

const MIN = 60_000;
/** ⛔ PIN UPDATED 2026-09-17 — the readings on this page (the Test relay verdict
 *  and the OS fingerprint) are re-taken by the six-hourly automatic capability
 *  check, so their display window is `MEASURED_READING_TTL_MS` (8 h), not the
 *  thirty minutes they inherited from the live-session verdict. 31 minutes is now
 *  a PRESENT-TENSE reading, so every "aged" arm below was pinning the defect the
 *  owner reported ("Has QUIC and Apple, but it aint green sometimes"). Nine hours
 *  is past the new window; the arms themselves are unchanged. */
const AGED_AGE = 9 * 60 * MIN;
const OS_READING = {
  os: 'macos-or-ios',
  confidence: 'high',
  reason: 'initial TTL 64, Darwin option layout',
  observedVia: 'exit_ip',
  singleHostVantage: true,
  webPortVantage: true,
};

/** An aged OS reading as the view state really holds it: the CACHED reading, which
 *  carries the `at` it was taken at — the same instant as the aged entry's `atMs`.
 *  These fixtures used to cast the bare reading (`OS_READING as OsFingerprint`), a
 *  shape `deriveProbeViewState` can never produce; the test tsconfig said so, and
 *  a chip that dates itself from `at` would have read `undefined`. */
const agedOsReading = (at: number): CachedOsFingerprint => ({
  ...(OS_READING as OsFingerprint),
  at,
});

/** One stored SOCKS5 entry, healthy and swept just now; `extra` is the readings
 *  under test. Nothing else on the entry can light the QUIC or the OS chip. */
function seed(extra: Record<string, unknown>): void {
  const entry = {
    result: UDP_OK,
    at: Date.now(),
    exitIp: '198.51.100.2',
    exitCountry: 'GB',
    serverLatencyMs: 20,
    measuredFrom: 'fleet',
    nodeId: 'mac-mini-07',
    ...extra,
  };
  stores.set(
    'proxy-probe-cache.json',
    new Map<string, unknown>([
      ['probes_schema', 2],
      ['probes', proxyRef.second ? { p1: entry, p2: entry } : { p1: entry }],
    ]),
  );
}

const relayAt = (ageMs: number): Record<string, unknown> => ({
  quicProbe: true,
  quicProbeAt: Date.now() - ageMs,
  osFingerprint: { ...OS_READING, at: Date.now() - ageMs },
});

async function cardQuicChip(container: HTMLElement): Promise<HTMLElement> {
  let el: HTMLElement | null = null;
  await waitFor(() => {
    el = container.querySelector('[data-region="caps"] [data-quic-inferred]');
    expect(el).not.toBeNull();
  });
  return el as unknown as HTMLElement;
}

/** The list's UDP chip — the cell whose tooltip carries the QUIC clause. */
async function listUdpChip(container: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: /List/ }));
  let el: HTMLElement | null = null;
  await waitFor(() => {
    el = container.querySelector('table td [title^="UDP works"]');
    expect(el).not.toBeNull();
  });
  return el as unknown as HTMLElement;
}
const listOsChip = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('table [data-component="proxy-os-fingerprint"]');

beforeEach(() => {
  stores.clear();
  proxyRef.serverId = 'aprx_1';
  proxyRef.second = false;
  window.localStorage.clear();
});
afterEach(cleanup);

describe('the profile CARD shows a reading that has aged out of the present tense', () => {
  it('(a) CRITICAL a relay reading nine hours old is the aged past-tense chip, dated — not "not yet tested"', async () => {
    seed(relayAt(AGED_AGE));
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await cardQuicChip(container);
    await waitFor(() => expect(chip.getAttribute('title')).toContain('rechecked automatically'));
    expect(chip.getAttribute('data-ok')).toBe('aged');
    expect(chip.getAttribute('data-aged-value')).toBe('true');
    expect(chip.getAttribute('data-quic-inferred')).toBe('false');
    // What it found AND how old it is. ⛔ PIN UPDATED 2026-09-17 with the window:
    // at 31 minutes the age did not fit the card's 206px default and rode in an
    // `sr-only` span ("QUIC ✓" + " · 31 min ago"); an hours-unit suffix is
    // narrower (29.91px against 41.9), so at nine hours the tile PRINTS it and the
    // hidden span is correctly absent. The claim is the same — the age reaches the
    // reader either way — and the width arm below pins both branches.
    expect(chip.textContent).toBe('QUIC ✓ · 9 h');
    expect(chip.querySelector('.sr-only')).toBeNull();
    // …never in the colour of a current verdict, NOR in the fill of a current
    // non-verdict ('⤵ QUIC' and 'QUIC ~' wear bg-ink-muted/15): recessed + dashed.
    expect(chip.className).not.toContain('status-ready');
    expect(chip.className).not.toContain('bg-ink-muted/15');
    expect(chip.className).toContain('bg-surface-inset');
    expect(chip.className).toContain('outline-dashed');
    // The age leads the hover, in the past tense.
    expect(chip.getAttribute('title')).toBe(
      'Last checked 9 hours ago. It will be rechecked automatically. HTTP/3 worked through this exit then.',
    );
    expect(chip.getAttribute('title')).not.toContain('not yet tested');
    // The OS reading came from the same Test and aged with it.
    const os = container.querySelector(
      '[data-region="caps"] [data-component="proxy-os-fingerprint"]',
    );
    expect(os?.getAttribute('data-ok')).toBe('aged');
    // OWNER 2026-09-24 — an aged APPLE reading keeps its green (aged chrome).
    expect(os?.getAttribute('data-os-tone')).toBe('match');
    expect(os?.getAttribute('title')).toMatch(/^Last checked 9 hours ago\./);
    // Same width story as the QUIC chip above: printed rather than hidden, and at
    // the card's default width the OS chip takes its SHORT label beside the age.
    expect(os?.textContent).toBe('✓ Apple · 9 h');
  });

  it('(a) the tile PRINTS the age on every aged chip as soon as the row has the room — all of them or none', () => {
    const NOW = Date.parse('2026-09-17T12:00:00.000Z');
    const aged = (min: number): CapsInput => ({
      hasProxy: true,
      capabilities: UDP_OK,
      testing: false,
      latencyMs: 12,
      nowMs: NOW,
      aged: {
        quicProbe: { value: true, atMs: NOW - min * MIN },
        osFingerprint: { value: agedOsReading(NOW - min * MIN), atMs: NOW - min * MIN },
      },
    });
    const texts = (p: CapsInput, w: number): string[] =>
      visibleChips(p, w).chips.map((c) => c.text);
    // The 178px column (144 of content): the trio has 1.32px to spare — no age,
    // and NOTHING is lost to make room for one (no '+N', same three chips).
    expect(texts(aged(31), 144)).toEqual(['UDP ✓', 'QUIC ✓', '✓ Apple']);
    expect(visibleChips(aged(31), 144).hiddenHints).toEqual([]);
    expect(visibleChips(aged(31), 144).chips.some((c) => c.ageShown === true)).toBe(false);
    // Reserved: 40.22 + (44.3 + 41.9) + (47.16 + 41.9) + 8 + the 3px floor = 226.48.
    expect(texts(aged(31), 226)).toEqual(['UDP ✓', 'QUIC ✓', '✓ iOS/macOS']);
    expect(texts(aged(31), 227)).toEqual(['UDP ✓', 'QUIC ✓ · 31 min', '✓ Apple · 31 min']);
    // Hours are narrower (29.91): 40.22 + 74.21 + 77.07 + 8 + 3 = 202.5.
    expect(texts(aged(240), 203)).toEqual(['UDP ✓', 'QUIC ✓ · 4 h', '✓ Apple · 4 h']);
    expect(texts(aged(240), 300)).toEqual(['UDP ✓', 'QUIC ✓ · 4 h', '✓ iOS/macOS · 4 h']);
    // A dated chip reserves what it prints: the literal plus its unit's widest suffix.
    const dated = visibleChips(aged(240), 300).chips.find((c) => c.key === 'quic');
    expect(dated?.width).toBeCloseTo(44.3 + 29.91, 5);
    expect(dated?.ageShown).toBe(true);
    // CONTROL: a row with nothing aged is cut exactly as before, at every width.
    const fresh: CapsInput = { ...aged(31), aged: undefined, quicProbe: true };
    for (const w of [144, 206, 227, 300]) {
      expect(texts(fresh, w).join('|')).not.toContain('·');
    }
  });

  it('(a) ⛔ an aged NEGATIVE does not look like a current negative', () => {
    const NOW = Date.parse('2026-09-17T12:00:00.000Z');
    const base: CapsInput = {
      hasProxy: true,
      capabilities: UDP_OK,
      testing: false,
      latencyMs: 12,
      nowMs: NOW,
    };
    const current = capabilityChips({ ...base, quicProbe: false }).eligible.find(
      (c) => c.key === 'quic',
    );
    const old = capabilityChips({
      ...base,
      aged: { quicProbe: { value: false, atMs: NOW - 240 * MIN } },
    }).eligible.find((c) => c.key === 'quic');
    expect(current?.text).toBe('⤵ QUIC');
    expect(old?.text).toBe('⤵ QUIC');
    // Same glyph, same word — so the FILL and the INK must differ, not only an edge.
    const fill = (cls: string | undefined): string[] =>
      (cls ?? '').split(' ').filter((t) => t.startsWith('bg-') || t.startsWith('text-'));
    expect(fill(current?.className)).toEqual(['bg-ink-muted/15', 'text-ink-secondary']);
    expect(fill(old?.className)).toEqual(['bg-surface-inset', 'text-ink-muted']);
  });

  it('(a) the details sheet, which has the room, prints the age beside the label', async () => {
    seed(relayAt(AGED_AGE));
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    await cardQuicChip(container);
    fireEvent.click(container.querySelector('[data-action="open-details"]') as HTMLElement);
    const sheet = await waitFor(() => {
      const el = container.querySelector('[data-component="card-details-sheet"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const quic = sheet.querySelector('[data-capability="quic"]');
    expect(quic?.getAttribute('data-ok')).toBe('aged');
    expect(quic?.textContent).toBe('✓QUIC · 9 h ago');
    const os = sheet.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(os?.getAttribute('data-ok')).toBe('aged');
    expect(os?.textContent).toBe('✓iOS/macOS · 9 h ago');
  });

  it('(a) ⛔ a row the automatic check will never take names its button — it promises nothing', async () => {
    proxyRef.serverId = undefined; // never saved to the account → never sent
    proxyRef.second = true; // …beside a row that IS, which the planner will take
    seed(relayAt(AGED_AGE));
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const titleOf = (name: string): string | null | undefined =>
      [...container.querySelectorAll('article')]
        .find((a) => a.textContent.includes(name))
        ?.querySelector('[data-region="caps"] [data-quic-inferred]')
        ?.getAttribute('title');
    // ⛔ A POSITIVE signal first. "Names its button" is also what every chip says
    // BEFORE the ledger read lands, so asserting it after a fixed sleep passes on
    // a slow machine whatever the planner answers; the other row's promise
    // appearing is the proof that the answer is in.
    await waitFor(() =>
      expect(titleOf('Second')).toBe(
        'Last checked 9 hours ago. It will be rechecked automatically. HTTP/3 worked through this exit then.',
      ),
    );
    expect(titleOf('Demo')).toBe(
      'Last checked 9 hours ago. Run Test to check it again. HTTP/3 worked through this exit then.',
    );
  });

  it('(b) CRITICAL ⛔ THE UPGRADE CLIFF — a relay reading with NO stamp (every install that pressed Test before gui-v0.1.63) is DATED by the load migration and RENDERS, as an AGED reading, never as "not yet tested" and never as a fresh green. MUTATION: drop backfillQuicProbeAt from migrateOnce and both blocks red', async () => {
    // ⛔ PIN UPDATED 2026-09-17 (review) — THIS ARM USED TO ASSERT THE GREEN, and
    // the green was the defect. The backfill borrows `serverProbeAt ?? at`, and
    // NEITHER is this verdict's own date: `serverProbeAt` is re-stamped on every
    // server reply including a pure carry, and the background sweep moves `at`
    // about every fifteen minutes. So "the entry's own `at` is recent" — the
    // sentence that used to justify the present tense here — says only that this
    // row was pinged recently, not that its relay verdict was. A verdict of
    // genuinely unknown age was being rendered as a present-tense ✓.
    //
    // The backfill now clamps the stamp into the AGED band, which is what the item
    // asked for in so many words, and what the cliff needed: the value is
    // RESTORED — visible, muted, dated — instead of being shown by nothing. What
    // this arm proves is unchanged in spirit and stronger in fact: the reading
    // comes back, and it does not lie about its age.
    seed({ quicProbe: true });
    let view = render(<ProfilesView onGoToSettings={vi.fn()} />);
    let chip = await cardQuicChip(view.container);
    await waitFor(() => expect(chip.getAttribute('data-ok')).toBe('aged'));
    expect(chip.getAttribute('data-aged-value')).toBe('true');
    // ⛔ NOT the inferred `~`: "shown by nothing" is exactly what the cliff was,
    // and an inferred chip is how it looked. The reading is really rendered.
    expect(chip.getAttribute('data-quic-inferred')).toBe('false');
    expect(chip.textContent).toContain('QUIC ✓');
    cleanup();

    // …and one that tested LAST WEEK is aged too, from ITS OWN older date rather
    // than the clamp boundary: the clamp is a ceiling on how YOUNG a recovered
    // stamp may claim to be, never an assignment that throws the real date away.
    stores.clear();
    seed({ quicProbe: true, at: Date.now() - 7 * 24 * 60 * MIN });
    view = render(<ProfilesView onGoToSettings={vi.fn()} />);
    chip = await cardQuicChip(view.container);
    await waitFor(() => expect(chip.getAttribute('data-ok')).toBe('aged'));
    expect(chip.getAttribute('data-aged-value')).toBe('true');
    expect(chip.textContent).toMatch(/7 d|days? ago/);
  });

  it('(c) PIN a FRESH reading renders exactly as it did before the aged state existed', async () => {
    seed(relayAt(5 * MIN));
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await cardQuicChip(container);
    expect(chip.outerHTML).toBe(
      '<span data-quic-inferred="false" title="This proxy carries QUIC — HTTP/3 works through this exit." ' +
        'class="inline-flex shrink-0 cursor-help items-center gap-0.5 whitespace-nowrap rounded-md px-1 py-px ' +
        'text-[9.5px] font-semibold leading-4 bg-status-ready/10 text-status-ready">QUIC ✓</span>',
    );
    const os = container.querySelector(
      '[data-region="caps"] [data-component="proxy-os-fingerprint"]',
    ) as HTMLElement;
    // The title ends in the reading's own age sentence, which is the clock's.
    expect(os.getAttribute('title')).toMatch(/ Measured by Driftstack, 5 minutes ago\.$/);
    os.removeAttribute('title');
    expect(os.outerHTML).toBe(
      '<span data-component="proxy-os-fingerprint" data-os-tone="match" ' +
        'class="inline-flex shrink-0 cursor-help items-center gap-0.5 whitespace-nowrap rounded-md px-1 py-px ' +
        'text-[9.5px] font-semibold leading-4 bg-status-ready/10 text-status-ready">✓ iOS/macOS</span>',
    );
  });

  it('(d) CONTROL a proxy whose QUIC was never measured still renders the unmeasured chip', async () => {
    seed({});
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await cardQuicChip(container);
    expect(chip.outerHTML).toBe(
      '<span data-quic-inferred="true" title="UDP works, so HTTP/3 is likely — not yet tested. Run Test or a session to confirm." ' +
        'class="inline-flex shrink-0 cursor-help items-center gap-0.5 whitespace-nowrap rounded-md px-1 py-px ' +
        'text-[9.5px] font-semibold leading-4 bg-ink-muted/15 text-ink-secondary">QUIC ~</span>',
    );
    const os = container.querySelector(
      '[data-region="caps"] [data-component="proxy-os-fingerprint"]',
    );
    expect(os?.textContent).toBe('— OS');
    expect(os?.getAttribute('data-ok')).toBeNull();
  });
});

describe('the profiles LIST shows a reading that has aged out of the present tense', () => {
  it('(a) CRITICAL nine hours old: the tooltip dates the QUIC reading and the OS chip is aged — it does not vanish', async () => {
    seed(relayAt(AGED_AGE));
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const udp = await listUdpChip(container);
    await waitFor(() => expect(udp.getAttribute('title')).toContain('rechecked automatically'));
    expect(udp.getAttribute('title')).toBe(
      'UDP works — WebRTC ✓. QUIC — Last checked 9 hours ago. It will be rechecked automatically. HTTP/3 worked through this exit then.',
    );
    expect(udp.getAttribute('title')).not.toContain('not yet measured');
    const os = listOsChip(container);
    expect(os).not.toBeNull();
    expect(os?.getAttribute('data-ok')).toBe('aged');
    // The chip is exactly as wide as the current one it stands in for (the
    // column has no room for an age beside the label — measured, see
    // AgedOsCellChip), so the age is PRINTED on its own line under the chips.
    expect(os?.textContent).toBe('✓iOS/macOS');
    const age = container.querySelector('table [data-component="aged-reading-age"]');
    expect(age?.textContent).toBe('as of 9 h ago');
    expect(os?.closest('td')?.contains(age)).toBe(true);
    expect(os?.getAttribute('title')).toMatch(/^Last checked 9 hours ago\. It will be rechecked/);
    expect(os?.className).toContain('outline-dashed');
    expect(os?.className).not.toContain('border');
    // OWNER 2026-09-24 — Apple keeps its green in the aged chrome.
    expect(os?.className).toContain('text-status-ready');
  });

  it('(a) ⛔ a row the automatic check will never take names its button in the list too', async () => {
    proxyRef.serverId = undefined;
    proxyRef.second = true;
    seed(relayAt(AGED_AGE));
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    await listUdpChip(container);
    const row = (name: string): HTMLElement | undefined =>
      [...container.querySelectorAll<HTMLElement>('table tbody tr')].find((tr) =>
        tr.textContent.includes(name),
      );
    const udpTitle = (name: string): string | null | undefined =>
      row(name)?.querySelector('td [title^="UDP works"]')?.getAttribute('title');
    const osTitle = (name: string): string | null | undefined =>
      row(name)?.querySelector('[data-component="proxy-os-fingerprint"]')?.getAttribute('title');
    // The positive signal first, as on the card: the OTHER row's promise.
    await waitFor(() =>
      expect(udpTitle('Second')).toContain('It will be rechecked automatically.'),
    );
    expect(osTitle('Second')).toMatch(/^Last checked 9 hours ago\. It will be rechecked/);
    expect(udpTitle('Demo')).toBe(
      'UDP works — WebRTC ✓. QUIC — Last checked 9 hours ago. Run Test to check it again. HTTP/3 worked through this exit then.',
    );
    expect(osTitle('Demo')).toMatch(/^Last checked 9 hours ago\. Run Test to check it again\./);
  });

  it('(b) CRITICAL ⛔ THE UPGRADE CLIFF, on the list: an undated pre-upgrade verdict is dated by the migration and STATED — in the past tense — not reported as "not yet measured"', async () => {
    // ⛔ PIN UPDATED 2026-09-17 (review) — the list half of the card arm above.
    // It pinned the present-tense "QUIC ✓" for a verdict whose age is unknown; the
    // backfill now clamps such a stamp into the aged band, so the list states the
    // reading in the past tense. The thing this arm exists to prove is unchanged:
    // the verdict is SAID, rather than being shown by nothing.
    seed({ quicProbe: true });
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const udp = await listUdpChip(container);
    expect(udp.getAttribute('title')).not.toContain('not yet measured');
    const title = udp.getAttribute('title') ?? '';
    expect(title).toContain('UDP works — WebRTC ✓');
    expect(title).toContain('HTTP/3 worked through this exit then.');
    // …and it leads with the AGE, which is the whole difference between a
    // recovered reading and a fresh one.
    expect(title).toMatch(/QUIC — Last checked 8 hours ago\./);
    // NOT the present tense — the control that this arm did not simply swap one
    // wrong sentence for another.
    expect(title).not.toMatch(/; QUIC ✓/);
  });

  it('(c) PIN a FRESH reading renders exactly as it did before the aged state existed', async () => {
    seed(relayAt(5 * MIN));
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const udp = await listUdpChip(container);
    expect(udp.outerHTML).toBe(
      '<span class="inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold bg-status-ready/10 text-status-ready" ' +
        'title="UDP works — WebRTC ✓; QUIC ✓">UDP ✓</span>',
    );
    // (2026-09-24, owner item 9) "UDP ✓" — the card's text AND the card's tone for
    // this reading (ready/10; ready/20 measured 3.98:1 on the selected row in the
    // light theme once the chip carried a word the WCAG gate reads). It was a bare
    // "✓" under a column named UDP, which now holds QUIC and OS.
    const os = listOsChip(container) as HTMLElement;
    expect(os.getAttribute('data-ok')).toBeNull();
    expect(os.getAttribute('data-os-tone')).toBe('match');
    expect(os.textContent).toBe('✓iOS/macOS');
    // HEAD's class string, byte for byte. This literal briefly carried
    // `whitespace-nowrap` because it was recorded while that class sat on the OS
    // chip in EVERY tone; it now lives on the aged branch alone, so a current chip
    // is exactly what it was before the aged state existed — which is the claim
    // this arm exists to check.
    expect(os.className).toBe(
      'inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-[10px] bg-status-ready/15 text-status-ready',
    );
    // A current reading is dated by nothing: the line belongs to aged chips only.
    expect(container.querySelector('[data-component="aged-reading-age"]')).toBeNull();
  });

  // ⛔ 2026-09-24 (owner item 9) — "and no OS chip at all" was the rule; the list
  // now states the card's absence instead: '— OS', "OS not measured yet", never an
  // empty cell. Still no age line, and still no reading claimed.
  it('(d) CONTROL never measured: "not yet measured", and the OS cell says not measured — never a reading', async () => {
    seed({});
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const udp = await listUdpChip(container);
    expect(udp.getAttribute('title')).toBe('UDP works — WebRTC ✓; QUIC likely (not yet measured)');
    const os = listOsChip(container) as HTMLElement;
    expect(os.textContent).toBe('—OS');
    expect(os.getAttribute('data-os-tone')).toBe('unknown');
    expect(os.getAttribute('title')).toBe('OS not measured yet. Run Test on this proxy.');
    expect(container.querySelector('[data-component="aged-reading-age"]')).toBeNull();
  });
});

// The VPN arms have no SOCKS5 result to render through ProfilesView's seed above
// without a second mock stack, so they are pinned on the two components' own
// inputs — the props ProfilesView hands them are the ones the arms above prove.
describe('a VPN row: an aged reading outranks "not measured", and is suppressed where it would mislead', () => {
  const NOW = Date.parse('2026-09-17T12:00:00.000Z');
  const FOUR_H = 4 * 60 * MIN;
  const vpnCaps = (over: Partial<CapsInput> = {}): CapsInput => ({
    hasProxy: true,
    capabilities: null,
    vpn: true,
    testing: false,
    latencyMs: 40,
    nowMs: NOW,
    aged: {
      quicProbe: { value: true, atMs: NOW - FOUR_H },
      udpProbe: { value: false, atMs: NOW - FOUR_H },
    },
    ...over,
  });

  it('the card: aged UDP and QUIC chips, dated in the hover, naming the button a VPN row has', () => {
    const { eligible } = capabilityChips(vpnCaps());
    const udp = eligible.find((c) => c.key === 'udp');
    const quic = eligible.find((c) => c.key === 'quic');
    expect(udp?.text).toBe('⤵ UDP');
    expect(udp?.attrs).toMatchObject({ 'data-udp': 'aged', 'data-ok': 'aged' });
    expect(udp?.dropFirst).toBeUndefined(); // a per-proxy reading keeps its place
    expect(udp?.agedAtMs).toBe(NOW - FOUR_H);
    expect(udp?.title).toBe(
      'Last checked 4 hours ago. Run Check VPN to check it again. UDP did not work through this VPN then.',
    );
    expect(quic?.text).toBe('QUIC ✓');
    expect(quic?.attrs).toMatchObject({ 'data-ok': 'aged', 'data-aged-value': 'true' });
    expect(quic?.className).not.toContain('status-ready');
    expect(quic?.title).toBe(
      'Last checked 4 hours ago. Run Check VPN to check it again. QUIC worked through this VPN then.',
    );
  });

  it('⛔ the aged OS chip names Check VPN on a VPN row — and Test on a proxy row', () => {
    const agedOs = { osFingerprint: { value: agedOsReading(NOW - FOUR_H), atMs: NOW - FOUR_H } };
    const osTitle = (p: CapsInput): string | undefined =>
      capabilityChips(p).eligible.find((c) => c.key === 'os')?.title;
    expect(osTitle(vpnCaps({ aged: agedOs }))).toMatch(
      /^Last checked 4 hours ago\. Run Check VPN to check it again\. What it found then: /,
    );
    expect(osTitle(vpnCaps({ aged: agedOs }))).not.toContain('Run Test');
    // CONTROL — the swap is the VPN row's only: a proxy row has a Test button.
    expect(osTitle(vpnCaps({ aged: agedOs, vpn: false, capabilities: UDP_OK }))).toMatch(
      /^Last checked 4 hours ago\. Run Test to check it again\. What it found then: /,
    );
    // …and where the recheck is automatic there is no button to name at all.
    expect(osTitle(vpnCaps({ aged: agedOs, autoRecheck: true }))).toMatch(
      /^Last checked 4 hours ago\. It will be rechecked automatically\. What it found then: /,
    );
    // The list's chip for the same reading says the same thing.
    const { container } = render(<ProfilesTable {...tableProps(tableRow({ aged: agedOs }))} />);
    const os = container.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(os?.getAttribute('title')).toMatch(
      /^Last checked 4 hours ago\. Run Check VPN to check it again\. What it found then: /,
    );
  });

  it('⛔ the details sheet of a VPN row prints the aged OS reading dated, and its hover names Check VPN too', () => {
    const cardProps: ProfilePhoneCardProps = {
      name: 'zurich banking',
      monogram: 'ZB',
      hue: 200,
      deviceLabel: 'iPhone 17',
      running: false,
      selected: false,
      lastUsedIso: null,
      folder: '',
      tags: [],
      hasProxy: true,
      proxyExplicit: true,
      flag: '🇨🇭',
      countryCode: 'CH',
      exitIp: '203.0.113.42',
      latencyMs: 40,
      latencyFillPct: 30,
      latencyGood: true,
      probed: true,
      capabilities: null,
      vpn: true,
      nowMs: NOW,
      aged: { osFingerprint: { value: agedOsReading(NOW - FOUR_H), atMs: NOW - FOUR_H } },
      checkedAtIso: null,
      busy: false,
      launching: false,
      anyBusy: false,
      testing: false,
      testDisabled: false,
      launchDisabled: false,
      onToggleSelect: vi.fn(),
      onPrimary: vi.fn(),
      onWatch: vi.fn(),
      onTest: vi.fn(),
    };
    const { container } = render(<ProfilePhoneCard {...cardProps} />);
    fireEvent.click(container.querySelector('[data-action="open-details"]') as HTMLElement);
    const sheet = container.querySelector('[data-component="card-details-sheet"]') as HTMLElement;
    const chips = sheet.querySelectorAll('[data-component="proxy-os-fingerprint"]');
    expect(chips).toHaveLength(1); // the tile's dated chip INSTEAD of the shared one
    expect(chips[0]?.textContent).toBe('✓ iOS/macOS · 4 h ago');
    expect(chips[0]?.getAttribute('data-ok')).toBe('aged');
    expect(chips[0]?.getAttribute('title')).toMatch(
      /^Last checked 4 hours ago\. Run Check VPN to check it again\./,
    );
    expect(sheet.textContent).not.toContain('Run Test');
  });

  it('⛔ a CURRENT reading always wins over an aged one', () => {
    const { eligible } = capabilityChips(vpnCaps({ quicProbe: false, udpProbe: true }));
    expect(eligible.find((c) => c.key === 'quic')?.attrs['data-ok']).toBeUndefined();
    expect(eligible.find((c) => c.key === 'quic')?.text).toBe('⤵ QUIC');
    expect(eligible.find((c) => c.key === 'udp')?.attrs).toEqual({ 'data-udp': 'true' });
  });

  it('⛔ no aged chip while a test runs, nor beside a failure sentence', () => {
    for (const over of [{ testing: true }, { vpnFailure: 'The tunnel did not come up.' }]) {
      const { eligible } = capabilityChips(vpnCaps(over));
      expect(eligible.some((c) => c.attrs['data-ok'] === 'aged')).toBe(false);
      expect(eligible.find((c) => c.key === 'udp')?.text).toBe('⇢ UDP');
    }
  });

  function tableRow(over: Partial<ProfileTableRow>): ProfileTableRow {
    return {
      id: 'p1',
      name: 'amsterdam shopper',
      deviceLabel: 'iPhone 17',
      running: false,
      hasProxy: true,
      flag: '🇳🇱',
      countryCode: 'NL',
      exitIp: '82.14.220.9',
      proxyAddress: 'vpn.example.com:51820',
      locationLabel: 'Netherlands',
      probed: true,
      udp: 'unknown',
      vpn: true,
      latencyMs: 42,
      folder: '',
      tags: [],
      note: '',
      sizeLabel: '—',
      createdAtIso: '2026-06-01T00:00:00.000Z',
      lastUsedIso: null,
      selected: false,
      busy: false,
      launching: false,
      testing: false,
      testDisabled: false,
      launchDisabled: false,
      ...over,
    };
  }
  const tableProps = (r: ProfileTableRow): ProfilesTableProps => ({
    rows: [r],
    nowMs: NOW,
    sortKey: 'name',
    sortDir: 'asc',
    onSort: vi.fn(),
    allSelected: false,
    onToggleSelectAll: vi.fn(),
    onToggleSelect: vi.fn(),
    onPrimary: vi.fn(),
    onWatch: vi.fn(),
    onStop: vi.fn(),
    onTest: vi.fn(),
    onEdit: vi.fn(),
    onTrim: vi.fn(),
    onDelete: vi.fn(),
    onSaveNote: vi.fn(),
  });
  const agedUdp = { udpProbe: { value: true, atMs: NOW - FOUR_H } };

  it('the list: an aged UDP reading replaces "UDP via tunnel", muted and dated', () => {
    const { container } = render(<ProfilesTable {...tableProps(tableRow({ aged: agedUdp }))} />);
    const chip = container.querySelector('[data-udp]');
    expect(chip?.getAttribute('data-udp')).toBe('aged');
    expect(chip?.getAttribute('data-ok')).toBe('aged');
    expect(chip?.textContent).toBe('✓UDP');
    expect(chip?.className).toContain('outline-dashed');
    expect(chip?.className).not.toContain('status-ready');
    expect(chip?.getAttribute('title')).toBe(
      'Last checked 4 hours ago. Run Check VPN to check it again. UDP worked through this VPN then.',
    );
    expect(container.querySelector('[data-component="aged-reading-age"]')?.textContent).toBe(
      'as of 4 h ago',
    );
  });

  it('the list: one age line for the cell states the OLDER of its two aged chips', () => {
    const aged = {
      udpProbe: { value: true, atMs: NOW - FOUR_H },
      osFingerprint: { value: agedOsReading(NOW - 45 * MIN), atMs: NOW - 45 * MIN },
    };
    const { container } = render(<ProfilesTable {...tableProps(tableRow({ aged }))} />);
    expect(container.querySelectorAll('[data-ok="aged"]')).toHaveLength(2);
    const lines = container.querySelectorAll('[data-component="aged-reading-age"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe('as of 4 h ago');
  });

  it('CONTROL the list: with nothing aged the row still says "⇢ UDP" (not measured)', () => {
    const { container } = render(<ProfilesTable {...tableProps(tableRow({}))} />);
    expect(container.querySelector('[data-udp]')?.textContent).toBe('⇢ UDP');
  });

  it('⛔ the list: no aged chip while the row is testing', () => {
    const { container } = render(
      <ProfilesTable {...tableProps(tableRow({ aged: agedUdp, testing: true }))} />,
    );
    expect(container.querySelector('[data-udp]')?.getAttribute('data-udp')).toBe('tunnel');
    expect(container.querySelector('[data-component="aged-reading-age"]')).toBeNull();
  });

  it('⛔ the list: no aged chip beside a failure sentence', () => {
    const { container } = render(
      <ProfilesTable
        {...tableProps(tableRow({ aged: agedUdp, vpnFailure: 'The tunnel did not come up.' }))}
      />,
    );
    expect(container.querySelector('[data-ok="aged"]')).toBeNull();
    expect(container.querySelector('[data-udp="aged"]')).toBeNull();
    expect(container.querySelector('[data-component="aged-reading-age"]')).toBeNull();
  });
});
