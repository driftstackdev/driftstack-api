/* eslint-disable @typescript-eslint/require-await -- the Tauri plugin mocks mirror Sidebar.test.tsx */
// Marketing scenes (2026-09-11) — the `?scene=` compositions in the visual
// harness are what scripts/marketing-screens.mjs captures for the marketing
// site. This guard renders every scene headless and pins the three things a
// screenshot cannot prove about itself:
//
//   1. PRIVACY — nothing rendered names a real proxy vendor / host or a
//      non-documentation exit IP. The gallery's own STATES carry vendor labels
//      and fixture IPs that look real (gate.nodemaven.com, 82.14.220.9); the
//      scenes lay *.example.com hosts and RFC 5737 TEST-NET exits over them.
//      Revert one override in MARKETING_CARDS / MARKETING_TABLE_ROWS and the
//      scan below reds on the vendor host or the non-TEST-NET address.
//   2. DETERMINISM — `freezeHarnessClock` pins Date.now to FROZEN_NOW_ISO
//      (relative-time labels, LiveElapsed, ConnectionPill's "last ok"), and
//      the module freezes it AT LOAD when `?scene=` is in the URL — before
//      STATES computes the live card's start time — so a human opening the
//      harness sees the frame the script captures (loaded fresh below with
//      the search string set).
//   3. SHAPE — each scene is the composition the script's guard expects
//      (per-scene stage size, 8 cards, the same 8 profiles as 8 rows sorted
//      by name, 3 editors with their saved tunnel configs, the observed Egress
//      readouts), the header tallies are derived from the declared verdicts,
//      and `sceneFromSearch` is the only door in.
//
// The Tauri plugin modules are mocked exactly as Sidebar.test.tsx does: the
// scenes render the REAL Sidebar through the real SettingsContext, and its
// mount effects touch the store / invoke.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    async get(): Promise<null> {
      return null;
    }
    async set(): Promise<void> {}
    async save(): Promise<void> {}
  },
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(async () => undefined),
  exists: vi.fn(async () => false),
  mkdir: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  readDir: vi.fn(async () => []),
  BaseDirectory: { AppData: 0 },
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
}));

import {
  FIXTURE_ACCOUNT,
  FROZEN_NOW_ISO,
  MARKETING_CARDS,
  MARKETING_PROXIES,
  MARKETING_PROXY_TALLY,
  MARKETING_SCENES,
  MARKETING_TABLE_ROWS,
  MarketingScene,
  freezeHarnessClock,
  proxyTally,
  sceneFromSearch,
  sceneSize,
} from '../../src/visual-harness/gallery';

afterEach(() => {
  cleanup();
});

/** Vendor / real-host markers that the gallery's STATES legitimately carry and
 *  a marketing capture must never show. A denylist alone lets an unlisted
 *  vendor through, so HOST_SHAPED below also requires every public-TLD host to
 *  be example.com's or the product's own. */
const FORBIDDEN_TEXT = /nodemaven|oxylabs|protonvpn|mullvad|driftstack\.dev|localhost/i;
/** Anything that reads as a public hostname: label(s) + a public TLD.
 *  Lookarounds, not `\b`: a host is scanned per TEXT NODE (below), but an
 *  attribute value can still run a host straight into a digit or letter. */
const HOST_SHAPED =
  /(?<![a-z0-9-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|co|ai|app|cloud|vpn|proxy)(?![a-z0-9-])/gi;
/** The only hostnames a scene may render: RFC 2606 example.com and driftstack.io. */
const ALLOWED_HOST = /(?:^|\.)example\.com$|^(?:app\.)?driftstack\.io$/i;
/** RFC 5737 documentation ranges — the only EXIT IPv4s a scene may render. */
const TEST_NET = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;
/** RFC 1918 private ranges — a tunnel's interior address / DNS (the WireGuard
 *  `Address = 10.7.0.2/32` line a real wg0.conf carries). Not an exit and
 *  identifies nobody; allowed alongside TEST-NET, never counted as an exit. */
const PRIVATE_NET = /^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/;
/** The unspecified address — the WireGuard `AllowedIPs = 0.0.0.0/0` "route
 *  everything" line. Not an exit either. */
const UNSPECIFIED = /^0\.0\.0\.0$/;
/** `\b` would miss "203.0.113.7Test" — the exit cell's address runs straight
 *  into its Test button when a row is read as one string. Lookarounds instead. */
const IPV4 = /(?<!\d)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\d)/g;
/** Scenes that show an EXIT (a measured address) — where the privacy scan must
 *  have SEEN at least one, or it scanned nothing (a component that stopped
 *  surfacing them would otherwise pass as clean). The Proxies scene shows
 *  hosts, not exits: its editors hold no test result. */
const EXIT_SCENES: ReadonlyArray<string> = ['profiles-grid', 'profiles-list', 'simulator'];

/** Every string a viewer could read off the render: each TEXT NODE on its own
 *  (root.textContent glues siblings together — "203.0.113.7" + "Test" — and a
 *  glued address is one a word-boundary scan walks past), and the attributes
 *  that surface on hover / to assistive tech / as input values. */
function visibleStrings(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (text.trim().length > 0) out.push(text);
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of ['title', 'aria-label', 'placeholder', 'value', 'alt']) {
      const v = el.getAttribute(attr);
      if (v !== null) out.push(v);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) out.push(el.value);
  }
  return out;
}

describe('sceneFromSearch — the only door into a marketing scene', () => {
  it('maps every known scene name and nothing else', () => {
    for (const name of MARKETING_SCENES) {
      expect(sceneFromSearch(`?scene=${name}`)).toBe(name);
    }
    expect(sceneFromSearch('')).toBeNull();
    expect(sceneFromSearch('?w=178')).toBeNull();
    expect(sceneFromSearch('?scene=')).toBeNull();
    expect(sceneFromSearch('?scene=profiles')).toBeNull();
    expect(sceneFromSearch('?scene=PROFILES-GRID')).toBeNull();
  });
});

describe('freezeHarnessClock — the capture clock', () => {
  it('pins Date.now to FROZEN_NOW_ISO and restores it', () => {
    const before = Date.now();
    const restore = freezeHarnessClock();
    try {
      expect(Date.now()).toBe(Date.parse(FROZEN_NOW_ISO));
      expect(Date.now()).toBe(Date.parse(FROZEN_NOW_ISO));
    } finally {
      restore();
    }
    // Real clock again: monotone from the pre-freeze reading, not the frozen one.
    expect(Date.now()).toBeGreaterThanOrEqual(before);
    expect(Date.now()).not.toBe(Date.parse(FROZEN_NOW_ISO));
  });
});

describe('every marketing scene', () => {
  for (const name of MARKETING_SCENES) {
    it(`${name}: is its declared stage and shows no real host, vendor or exit IP`, () => {
      const restore = freezeHarnessClock();
      try {
        const size = sceneSize(name);
        const { container } = render(<MarketingScene name={name} />);
        const stage = container.querySelector<HTMLElement>(`[data-scene="${name}"]`);
        expect(stage).not.toBeNull();
        if (stage === null) return;
        expect(stage.getAttribute('data-ready')).toBe('1');
        expect(stage.style.width).toBe(`${String(size.width)}px`);
        expect(stage.style.height).toBe(`${String(size.height)}px`);
        // What the capture script cross-checks against its own mirror.
        expect(stage.getAttribute('data-frozen-now')).toBe(FROZEN_NOW_ISO);
        expect(stage.getAttribute('data-stage-width')).toBe(String(size.width));
        expect(stage.getAttribute('data-stage-height')).toBe(String(size.height));
        // A stage that rendered nothing must not pass as a clean one.
        expect((stage.textContent ?? '').trim().length).toBeGreaterThan(40);

        const strings = visibleStrings(stage);
        let ipsSeen = 0;
        let hostsSeen = 0;
        for (const s of strings) {
          expect(s).not.toMatch(FORBIDDEN_TEXT);
          for (const ip of s.match(IPV4) ?? []) {
            if (PRIVATE_NET.test(ip) || UNSPECIFIED.test(ip)) continue;
            ipsSeen += 1;
            expect(ip, `non-TEST-NET IPv4 "${ip}" rendered in scene ${name}`).toMatch(TEST_NET);
          }
          for (const host of s.match(HOST_SHAPED) ?? []) {
            hostsSeen += 1;
            expect(host, `real-looking host "${host}" rendered in scene ${name}`).toMatch(
              ALLOWED_HOST,
            );
          }
        }
        // Positive control: the scan saw what it claims to have vetted.
        expect(hostsSeen, `${name}: no hostname reached the scan`).toBeGreaterThan(0);
        if (EXIT_SCENES.includes(name)) {
          expect(ipsSeen, `${name}: no exit IP reached the scan`).toBeGreaterThan(0);
        }
      } finally {
        restore();
      }
    });
  }
});

describe('the harness freezes its own clock at load when a scene is requested', () => {
  // The capture script pins the page clock before navigation, so a stale
  // freeze in the harness would never show in a capture — only to a human
  // opening `?scene=`. Load the module fresh with the search string set and
  // read the clock AND the live card's start time, which STATES computes at
  // module load: a freeze that runs after STATES leaves that offset counted
  // from the real clock.
  it('Date.now is FROZEN_NOW_ISO and the live card started 12 minutes before it', async () => {
    const original = Date.now;
    window.history.replaceState({}, '', '?scene=profiles-grid');
    vi.resetModules();
    try {
      const fresh = await import('../../src/visual-harness/gallery');
      expect(Date.now()).toBe(Date.parse(fresh.FROZEN_NOW_ISO));
      const live = fresh.MARKETING_CARDS.find((c) => c.label === 'running · live');
      expect(live).toBeDefined();
      const since = live?.props.runningSinceIso;
      expect(typeof since).toBe('string');
      expect(Date.parse(fresh.FROZEN_NOW_ISO) - Date.parse(since ?? '')).toBe(12 * 60_000);
      // The list's live row counts from the same instant.
      const row = fresh.MARKETING_TABLE_ROWS.find((r) => r.running);
      expect(row?.runningSinceIso).toBe(since);
    } finally {
      Date.now = original;
      window.history.replaceState({}, '', '/');
      vi.resetModules();
    }
  });
});

describe('scene shapes — what scripts/marketing-screens.mjs guards at capture', () => {
  it('profiles-grid: the 8 curated cards, each derived from an existing gallery state', () => {
    expect(MARKETING_CARDS).toHaveLength(8);
    const { container } = render(<MarketingScene name="profiles-grid" />);
    const cards = container.querySelectorAll('[data-scene-region="grid"] article');
    expect(cards).toHaveLength(8);
    // The grid frames the Profiles view: the real action bar + the Grid toggle pressed.
    expect(container.querySelector('[data-component="profiles-hero"]')).not.toBeNull();
    const pressed = Array.from(container.querySelectorAll('button[aria-pressed="true"]')).map((b) =>
      b.textContent?.trim(),
    );
    expect(pressed).toContain('▦ Grid');
  });

  it('profiles-list: the SAME eight profiles as the grid, one row each, sorted by name as the header says', () => {
    const { container } = render(<MarketingScene name="profiles-list" />);
    const rows = container.querySelectorAll('[data-scene-region="list"] tbody tr');
    expect(rows).toHaveLength(MARKETING_TABLE_ROWS.length);
    // One fleet: the sidebar badge (FIXTURE_ACCOUNT), the grid and the list agree.
    expect(MARKETING_TABLE_ROWS).toHaveLength(FIXTURE_ACCOUNT.profile_count);
    expect(MARKETING_CARDS).toHaveLength(FIXTURE_ACCOUNT.profile_count);
    const cardNames = MARKETING_CARDS.map((c) => c.props.name).sort();
    const rowNames = MARKETING_TABLE_ROWS.map((r) => r.name);
    expect([...rowNames].sort()).toEqual(cardNames);
    expect(rowNames).toEqual([...rowNames].sort((a, b) => a.localeCompare(b)));
    expect(container.textContent).toContain(`${String(FIXTURE_ACCOUNT.profile_count)} profiles`);
    // The same profile is the same on both surfaces: the live one, the selected one, the tunnel.
    const liveCard = MARKETING_CARDS.find((c) => c.props.running)?.props.name;
    expect(MARKETING_TABLE_ROWS.filter((r) => r.running).map((r) => r.name)).toEqual([liveCard]);
    const selectedCard = MARKETING_CARDS.find((c) => c.props.selected)?.props.name;
    expect(MARKETING_TABLE_ROWS.filter((r) => r.selected).map((r) => r.name)).toEqual([
      selectedCard,
    ]);
    const vpnCard = MARKETING_CARDS.find((c) => c.props.vpn === true)?.props.name;
    expect(MARKETING_TABLE_ROWS.filter((r) => r.vpn === true).map((r) => r.name)).toEqual([
      vpnCard,
    ]);
    for (const row of MARKETING_TABLE_ROWS) {
      if (row.proxyAddress !== null) expect(row.proxyAddress).toMatch(/\.example\.com:\d+$/);
      if (row.exitIp !== null) expect(row.exitIp).toMatch(TEST_NET);
      expect(row.launching, row.name).toBe(false);
    }
    const pressed = Array.from(container.querySelectorAll('button[aria-pressed="true"]')).map((b) =>
      b.textContent?.trim(),
    );
    expect(pressed).toContain('☰ List');
    expect(container.querySelector<HTMLSelectElement>('select[value="name"], select')?.value).toBe(
      'name',
    );
  });

  it('proxies: three editors in edit mode, each holding what a stored row holds, under a header derived from the verdicts', () => {
    const { container } = render(<MarketingScene name="proxies" />);
    expect(container.querySelectorAll('[data-scene-region="proxy-forms"] form')).toHaveLength(3);
    expect(container.querySelector('[data-component="proxies-hero"]')).not.toBeNull();
    // A stored WireGuard row always has its block: the editor shows the saved
    // summary (endpoint / address / allowed IPs / DNS — never a key) and the
    // replace box is empty, not the add-mode placeholder.
    const wg = MARKETING_PROXIES.find((p) => p.draft.scheme === 'wireguard')?.draft.wireguard;
    expect(wg).toBeDefined();
    const summary = container.querySelector('[data-component="wg-saved-summary"]');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain(`endpoint ${wg?.endpoint ?? ''}`);
    expect(summary?.textContent).toContain(`address ${wg?.address ?? ''}`);
    expect(summary?.textContent).not.toContain(wg?.private_key ?? 'never');
    const textareas = Array.from(
      container.querySelectorAll<HTMLTextAreaElement>('[data-scene-region="proxy-forms"] textarea'),
    );
    expect(textareas.map((t) => t.placeholder)).not.toContain(
      '[Interface]\nPrivateKey = …\n[Peer]\nPublicKey = …\nEndpoint = host:port',
    );
    // A stored OpenVPN row shows its config in the box; its auth user rides in
    // the block, not as a SOCKS-style credential.
    const ovpn = MARKETING_PROXIES.find((p) => p.draft.scheme === 'openvpn')?.draft;
    expect(ovpn?.username).toBeNull();
    expect(textareas.some((t) => t.value.startsWith('client\n'))).toBe(true);
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>('input')).some(
        (i) => i.value === ovpn?.openvpn?.username,
      ),
    ).toBe(true);
    // Header tallies: derived, and in ProxiesView's terms — a tunnel is healthy
    // when the fleet brought it up, and the WebRTC + QUIC tally counts only
    // SOCKS5 rows with a measured UDP associate (never VPN rows).
    const tally = container.querySelector('[data-component="scene-proxies-tally"]');
    expect(tally?.getAttribute('data-healthy')).toBe(String(MARKETING_PROXY_TALLY.healthy));
    expect(tally?.getAttribute('data-udp')).toBe(String(MARKETING_PROXY_TALLY.udpCapable));
    expect(tally?.textContent).toContain(`${String(MARKETING_PROXY_TALLY.healthy)} healthy`);
    expect(tally?.textContent).toContain(
      `${String(MARKETING_PROXY_TALLY.udpCapable)} WebRTC + QUIC`,
    );
    expect(MARKETING_PROXY_TALLY).toEqual({ total: 3, healthy: 3, udpCapable: 1 });
    expect(proxyTally([{ verdict: 'vpn_up' }, { verdict: 'vpn_up' }])).toEqual({
      total: 2,
      healthy: 2,
      udpCapable: 0,
    });
    expect(proxyTally([{ verdict: 'untested' }, { verdict: 'socks5_ok' }])).toEqual({
      total: 2,
      healthy: 1,
      udpCapable: 0,
    });
  });

  it('simulator: the real toolbar (live) and the observed Egress readouts', () => {
    const { container } = render(<MarketingScene name="simulator" />);
    expect(container.querySelector('[data-component="simulator-toolbar"]')).not.toBeNull();
    expect(
      container.querySelector('[data-component="simulator-running-indicator"]'),
    ).not.toBeNull();
    for (const c of ['sim-exit-ip-chip', 'sim-quic-readout', 'sim-os-readout']) {
      const el = container.querySelector(`[data-component="${c}"]`);
      expect(el, c).not.toBeNull();
      expect(el?.getAttribute('data-state'), c).toBe('observed');
    }
    // A coherent exit: the WebRTC candidate equals the exit, so no leak is cried.
    expect(
      container
        .querySelector('[data-component="sim-webrtc-candidates"]')
        ?.getAttribute('data-leak'),
    ).toBe('false');
  });

  it('billing + command-center: the app chrome frames the real panels', () => {
    const billing = render(<MarketingScene name="billing" />);
    expect(billing.container.textContent).toContain('Usage & cost');
    expect(billing.container.querySelector('aside nav[aria-label="Primary"]')).not.toBeNull();
    expect(billing.container.querySelector('button[aria-current="page"]')?.textContent).toContain(
      'Billing',
    );
    cleanup();
    const home = render(<MarketingScene name="command-center" />);
    expect(home.container.querySelector('h1')?.textContent).toBe('What do you want to automate?');
    expect(home.container.querySelector('button[aria-current="page"]')?.textContent).toContain(
      'Command center',
    );
  });
});
