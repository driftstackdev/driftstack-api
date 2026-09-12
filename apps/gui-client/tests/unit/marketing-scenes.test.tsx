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
import { StrictMode } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type * as TauriCore from '@tauri-apps/api/core';
import type * as TauriStore from '@tauri-apps/plugin-store';
import type * as TauriFs from '@tauri-apps/plugin-fs';

// Audit scenes (2026-09-12) install a window-level Tauri stub —
// `window.__TAURI_INTERNALS__.invoke` — the way the browser gate sees them.
// The three plugin mocks below ROUTE through it when it is installed (the REAL
// plugin-store / plugin-fs code then runs over the stub, exactly the path the
// gate exercises) and keep their old inert answers (null / '' / false / [])
// when it is not, so the marketing scenes render as they always did.
const { tauriStub } = vi.hoisted(() => ({
  tauriStub: (): { invoke: (cmd: string, args?: unknown) => Promise<unknown> } | undefined => {
    const w = window as Window & {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    };
    return w.__TAURI_INTERNALS__;
  },
}));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    const stub = tauriStub();
    return stub === undefined ? null : stub.invoke(cmd, args);
  }),
}));
vi.mock('@tauri-apps/plugin-store', async (importOriginal) => {
  const real = await importOriginal<typeof TauriStore>();
  class LazyStore {
    private readonly inner: InstanceType<typeof real.LazyStore>;
    constructor(path: string) {
      this.inner = new real.LazyStore(path);
    }
    async get<T>(key: string): Promise<T | null | undefined> {
      return tauriStub() === undefined ? null : this.inner.get<T>(key);
    }
    async set(key: string, value: unknown): Promise<void> {
      if (tauriStub() !== undefined) await this.inner.set(key, value);
    }
    async save(): Promise<void> {
      if (tauriStub() !== undefined) await this.inner.save();
    }
  }
  return { LazyStore };
});
vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => {
  const real = await importOriginal<typeof TauriFs>();
  const routed =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>, inert: R) =>
    async (...a: A): Promise<R> =>
      tauriStub() === undefined ? inert : fn(...a);
  return {
    readTextFile: vi.fn(routed(real.readTextFile, '')),
    writeTextFile: vi.fn(routed(real.writeTextFile, undefined)),
    exists: vi.fn(routed(real.exists, false)),
    mkdir: vi.fn(routed(real.mkdir, undefined)),
    remove: vi.fn(routed(real.remove, undefined)),
    readDir: vi.fn(routed(real.readDir, [])),
    BaseDirectory: real.BaseDirectory,
  };
});
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
  ALL_SCENES,
  AUDIT_SCENES,
  FIXTURE_ACCOUNT,
  FROZEN_NOW_ISO,
  MARKETING_CARDS,
  MARKETING_PROXIES,
  MARKETING_PROXY_TALLY,
  MARKETING_SCENES,
  MARKETING_TABLE_ROWS,
  MarketingScene,
  freezeHarnessClock,
  isAuditScene,
  proxyTally,
  sceneFromSearch,
  sceneSize,
} from '../../src/visual-harness/gallery';
import {
  AuditScene,
  auditFleetMembers,
  auditLoadedMarkers,
  auditSceneSizes,
  isAuditTauriStubInstalled,
} from '../../src/visual-harness/audit-scenes';

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

describe('sceneFromSearch — the only door into a scene, marketing or audit', () => {
  it('maps every known scene name and nothing else', () => {
    for (const name of MARKETING_SCENES) {
      expect(sceneFromSearch(`?scene=${name}`)).toBe(name);
    }
    for (const name of AUDIT_SCENES) {
      expect(sceneFromSearch(`?scene=${name}`)).toBe(name);
    }
    expect(sceneFromSearch('')).toBeNull();
    expect(sceneFromSearch('?w=178')).toBeNull();
    expect(sceneFromSearch('?scene=')).toBeNull();
    expect(sceneFromSearch('?scene=profiles')).toBeNull();
    expect(sceneFromSearch('?scene=PROFILES-GRID')).toBeNull();
    expect(sceneFromSearch('?scene=audit-')).toBeNull();
    expect(sceneFromSearch('?scene=audit-profiles')).toBeNull();
    expect(sceneFromSearch('?scene=__list__')).toBeNull();
  });

  it('ALL_SCENES is the six marketing scenes, in capture order, then every audit scene', () => {
    // What scripts/gui-text-quality.mjs reads (with sceneSize) — one source.
    expect(ALL_SCENES.slice(0, MARKETING_SCENES.length)).toEqual([...MARKETING_SCENES]);
    expect(ALL_SCENES.slice(MARKETING_SCENES.length)).toEqual([...AUDIT_SCENES]);
    expect(new Set(ALL_SCENES).size).toBe(ALL_SCENES.length);
    expect(AUDIT_SCENES).toHaveLength(9);
    for (const name of ALL_SCENES) {
      expect(isAuditScene(name)).toBe(name.startsWith('audit-'));
      const size = sceneSize(name);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
      if (isAuditScene(name)) expect(size).toEqual(auditSceneSizes()[name]);
    }
    // The marketing sizes did not move (scripts/marketing-screens.mjs mirrors them).
    expect(sceneSize('profiles-list')).toEqual({ width: 1800, height: 880 });
    expect(sceneSize('proxies')).toEqual({ width: 1280, height: 800 });
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

// The loaded-state markers per audit scene (`auditLoadedMarkers`) live in the
// harness beside the fixtures they read — one source for this file's privacy
// arms and profile-phone-card.test.tsx's every-scene stage arm. An audit scene
// whose data never arrived renders its empty / skeleton state, which carries
// no host and no IP and would otherwise pass the privacy scan as clean.

/** Audit scenes that show an IPv4 the scan must have SEEN (the fleet rigs on
 *  TEST-NET). The rest render hosts only. */
const AUDIT_IP_SCENES: ReadonlyArray<string> = ['audit-fleet'];
/** The audit scenes render the views' OWN copy, which names two hosts the
 *  marketing allowlist does not: `api.driftstack.dev` — SettingsView's cloud
 *  option label, the product's public API endpoint every customer sees. It
 *  identifies nobody and is shipped copy, so it is allowed BY NAME (not by
 *  pattern — a second host still fails). TeamView's invite placeholder is
 *  `teammate@example.com` since 2026-09-12 (it was `company.com`, a real
 *  registered domain). The vendor / localhost / other-driftstack.dev markers
 *  stay forbidden. */
const AUDIT_ALLOWED_HOST =
  /(?:^|\.)example\.com$|^(?:app\.)?driftstack\.io$|^api\.driftstack\.dev$/i;
const AUDIT_FORBIDDEN_TEXT =
  /nodemaven|oxylabs|protonvpn|mullvad|staging\.driftstack\.dev|localhost/i;
/** Two more pieces of shipped copy: SettingsView's support mailto and the
 *  self-hosted URL field's placeholder (DEFAULT_SETTINGS.baseUrl). Removed
 *  VERBATIM before the scan, so a bare `driftstack.dev` or `localhost`
 *  anywhere else (an ops host, a staging URL, a real self-hosted value)
 *  still fails. */
const AUDIT_COPY_LITERALS: ReadonlyArray<string> = [
  'support@driftstack.dev',
  'http://localhost:3000',
];
/** The wizard is the one scene without the window chrome (it draws its own
 *  TitleBar), so no base URL reaches its DOM — its positive control is the
 *  welcome heading in auditLoadedMarkers, not a host. */
const AUDIT_NO_HOST_SCENES: ReadonlyArray<string> = ['audit-first-run'];

/** The marketing privacy scan over an audit scene's rendered strings, with the
 *  named copy hosts allowed: nothing forbidden, every public IPv4 on TEST-NET,
 *  every public-TLD host on the allowlist, and the positive controls (a host
 *  reached the scan; for the IP scenes, an address did). ONE function for BOTH
 *  audit arms below — the StrictMode arm and the non-StrictMode fallback for a
 *  KNOWN_UNLOADED scene — so a scene whose StrictMode render is its skeleton
 *  (no member / invite rows) is still scanned in its LOADED state. Mutation:
 *  `member_email: 'ana@example.com'` → `'ana@oxylabs.io'` in auditTeam()
 *  (audit-scenes.tsx) reds the non-StrictMode audit-team arm on
 *  AUDIT_FORBIDDEN_TEXT; a `toContain`-only arm let it through. */
function expectAuditPrivacy(name: string, strings: ReadonlyArray<string>): void {
  let ipsSeen = 0;
  let hostsSeen = 0;
  for (const raw of strings) {
    const s = AUDIT_COPY_LITERALS.reduce((acc, lit) => acc.split(lit).join(' '), raw);
    expect(s).not.toMatch(AUDIT_FORBIDDEN_TEXT);
    for (const ip of s.match(IPV4) ?? []) {
      if (PRIVATE_NET.test(ip) || UNSPECIFIED.test(ip)) continue;
      ipsSeen += 1;
      expect(ip, `non-TEST-NET IPv4 "${ip}" rendered in scene ${name}`).toMatch(TEST_NET);
    }
    for (const host of s.match(HOST_SHAPED) ?? []) {
      hostsSeen += 1;
      expect(host, `real-looking host "${host}" rendered in scene ${name}`).toMatch(
        AUDIT_ALLOWED_HOST,
      );
    }
  }
  if (!AUDIT_NO_HOST_SCENES.includes(name)) {
    expect(hostsSeen, `${name}: no hostname reached the scan`).toBeGreaterThan(0);
  }
  if (AUDIT_IP_SCENES.includes(name)) {
    expect(ipsSeen, `${name}: no IPv4 reached the scan`).toBeGreaterThan(0);
  }
}

/** The harness mounts under React.StrictMode (visual-harness/main.tsx), whose
 *  simulated unmount → remount every view's mount logic — and the scene's
 *  Tauri stub lifecycle — must survive. Render the audit scenes the same way,
 *  so this arm measures what the gate's browser shows and not a gentler tree. */
function renderAudit(name: (typeof AUDIT_SCENES)[number]): ReturnType<typeof render> {
  return render(
    <StrictMode>
      <AuditScene name={name} />
    </StrictMode>,
  );
}

/** Scenes whose view does NOT reach its loaded state under StrictMode today —
 *  the defect, in the view, that the browser gate measures around. Each stays
 *  here until the view is fixed; the `it.fails` arm below flips red the moment
 *  it is, so the entry (and that arm) get removed together. */
const KNOWN_UNLOADED_UNDER_STRICT_MODE: Readonly<Record<string, string>> = {
  // (empty since 2026-09-12: TeamView's mountedRef is set on every mount — the
  // StrictMode remount no longer drops its load. Add an entry only with the
  // defect's exact cause; the it.fails arm below flips red when it is fixed.)
};

describe('every audit scene — the REAL view, loaded, under the marketing privacy scan', () => {
  for (const name of AUDIT_SCENES) {
    it(`${name}: is its declared stage, reaches its loaded state and shows no real host, vendor or exit IP`, async () => {
      const restore = freezeHarnessClock();
      try {
        const size = sceneSize(name);
        const { container } = renderAudit(name);
        const stage = container.querySelector<HTMLElement>(`[data-scene="${name}"]`);
        expect(stage).not.toBeNull();
        if (stage === null) return;
        expect(stage.getAttribute('data-ready')).toBe('1');
        expect(stage.style.width).toBe(`${String(size.width)}px`);
        expect(stage.style.height).toBe(`${String(size.height)}px`);
        expect(stage.getAttribute('data-frozen-now')).toBe(FROZEN_NOW_ISO);
        expect(stage.getAttribute('data-stage-width')).toBe(String(size.width));
        expect(stage.getAttribute('data-stage-height')).toBe(String(size.height));

        // LOADED — wait for the last fixture marker (the views load async:
        // client promises, the store / fs stub, the log buffer), then require
        // every marker in the rendered strings (text nodes + attributes +
        // input values; a fixture that only reaches a `value` still counts).
        const markers = auditLoadedMarkers(name);
        const last = markers[markers.length - 1] ?? '';
        if (KNOWN_UNLOADED_UNDER_STRICT_MODE[name] === undefined) {
          await waitFor(() => expect(visibleStrings(stage).join('\n')).toContain(last), {
            timeout: 5_000,
          });
        }
        const strings = visibleStrings(stage);
        const joined = strings.join('\n');
        if (KNOWN_UNLOADED_UNDER_STRICT_MODE[name] === undefined) {
          for (const marker of markers) {
            expect(joined, `${name}: fixture "${marker}" never reached the DOM`).toContain(marker);
          }
        }
        expect((stage.textContent ?? '').trim().length).toBeGreaterThan(40);

        // PRIVACY — the marketing scan, with the two named copy hosts allowed.
        // For a KNOWN_UNLOADED scene this walks the skeleton; the non-StrictMode
        // arm below scans that scene's LOADED strings with the same function.
        expectAuditPrivacy(name, strings);
      } finally {
        restore();
      }
    });
  }

  for (const [name, why] of Object.entries(KNOWN_UNLOADED_UNDER_STRICT_MODE)) {
    // Flips RED the moment the view is fixed: promote to `it`, drop the entry.
    it.fails(`${name}: reaches its loaded state under StrictMode — ${why}`, async () => {
      const restore = freezeHarnessClock();
      try {
        const { container } = renderAudit(name as (typeof AUDIT_SCENES)[number]);
        const stage = container.querySelector<HTMLElement>(`[data-scene="${name}"]`);
        expect(stage).not.toBeNull();
        if (stage === null) return;
        const markers = auditLoadedMarkers(name as (typeof AUDIT_SCENES)[number]);
        await waitFor(
          () => expect(visibleStrings(stage).join('\n')).toContain(markers[markers.length - 1]),
          { timeout: 2_000 },
        );
      } finally {
        restore();
      }
    });
    // …and, without StrictMode, the same view DOES load from the same fixture
    // client — the defect is the remount, not the scene — and its LOADED
    // strings (the member / invite rows the StrictMode arm never sees) go
    // through the same privacy scan: the fixture rows are where a vendor host
    // would sit, so a marker-only check here left them unvetted.
    it(`${name}: reaches its loaded state without StrictMode (the fixture client is complete) and that state passes the privacy scan`, async () => {
      const restore = freezeHarnessClock();
      try {
        const { container } = render(<AuditScene name={name as (typeof AUDIT_SCENES)[number]} />);
        const stage = container.querySelector<HTMLElement>(`[data-scene="${name}"]`);
        expect(stage).not.toBeNull();
        if (stage === null) return;
        const markers = auditLoadedMarkers(name as (typeof AUDIT_SCENES)[number]);
        await waitFor(
          () => expect(visibleStrings(stage).join('\n')).toContain(markers[markers.length - 1]),
          { timeout: 5_000 },
        );
        const strings = visibleStrings(stage);
        const joined = strings.join('\n');
        for (const marker of markers) expect(joined).toContain(marker);
        expectAuditPrivacy(name, strings);
      } finally {
        restore();
      }
    });
  }

  it('the Tauri stub is on the window only while a stubbed audit scene is mounted', async () => {
    // Before: nothing. A marketing scene never installs it.
    expect(isAuditTauriStubInstalled()).toBe(false);
    render(<MarketingScene name="billing" />);
    expect(isAuditTauriStubInstalled()).toBe(false);
    cleanup();
    // During: installed in the RENDER phase, so FleetView's mount effect (a
    // LazyStore.get through the real plugin-store over the stub) finds it —
    // and StrictMode's unmount → remount (renderAudit) keeps it installed
    // across the re-run of those effects.
    const { findByText } = renderAudit('audit-fleet');
    expect(isAuditTauriStubInstalled()).toBe(true);
    await findByText(auditFleetMembers()[0]?.label ?? '');
    // After: removed one microtask after unmount (StrictMode's synchronous
    // unmount → remount re-installs before that tick lands).
    cleanup();
    expect(isAuditTauriStubInstalled()).toBe(true);
    await Promise.resolve();
    expect(isAuditTauriStubInstalled()).toBe(false);
  });

  it('an audit scene is the view inside the real window chrome, with its sidebar entry current', async () => {
    // Settings has a sidebar entry (Sessions / Fleet / Connectivity are
    // palette-only views: `current` names them, nothing highlights).
    const settings = renderAudit('audit-settings');
    expect(settings.container.querySelector('aside nav[aria-label="Primary"]')).not.toBeNull();
    expect(settings.container.querySelector('button[aria-current="page"]')?.textContent).toContain(
      'Settings',
    );
    cleanup();
    // The view, not a replica: the fixture session the client returned.
    const sessions = renderAudit('audit-sessions');
    expect(sessions.container.querySelector('aside nav[aria-label="Primary"]')).not.toBeNull();
    await sessions.findByText('Amsterdam checkout');
  });
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

/* An OPAQUE IDENTIFIER: a value a reader cannot reconstruct from a prefix.
 * `ses_audit_berlin_price_watch`, `rec_audit_price_watch`, `prof_tokyo_qa` —
 * every one of them is a lookup key the customer pastes into a support
 * thread. Prose truncates gracefully ("Amsterdam check…" still reads); an id
 * truncated to `ses_audit_berl…` is simply lost. */
const OPAQUE_ID = /^[a-z]{2,6}_[a-z0-9][a-z0-9_-]{5,}$/;

/* …with ONE class carved out, in the opposite direction. An API key, a
 * webhook signing secret and an OAuth token are rendered THROUGH
 * `maskApiKey` precisely so the full value is NOT on the page, and a `title`
 * carrying it would hand the secret to anyone who hovers — and to every
 * screenshot tool that renders tooltips. They are id-shaped and they must
 * stay unreachable, so the scan skips them by their own key prefixes (the
 * same list `maskApiKey` knows). A short fixture body masks to itself, which
 * is why they reach this scan looking whole. */
const SECRET_PREFIXES = ['ds_live_', 'ds_test_', 'whsec_v1_', 'oas_', 'oat_'];
const isSecret = (text: string): boolean => SECRET_PREFIXES.some((p) => text.startsWith(p));

/** The browser gate's own reachability rule (`titled()` in
 *  scripts/gui-text-quality.mjs): the element itself or one of six ancestors
 *  carries a `title` / `aria-label`, so the full value is one hover away. */
function reachable(el: Element): boolean {
  let e: Element | null = el;
  for (let i = 0; i < 6 && e !== null; i += 1) {
    if (e.getAttribute('title') !== null || e.getAttribute('aria-label') !== null) return true;
    e = e.parentElement;
  }
  return false;
}

/* 2026-09-12 — the FIRST Linux run of .github/workflows/gui-gates.yml
 * (run 34677757888) found one defect neither Mac had ever shown: on the
 * audit-recordings scene, in BOTH themes, a recording card's name paragraph
 * clipped 17px of `ses_audit_berlin_price_watch` with no title. The card
 * names a recording by `label ?? sessionId`, and an unlabelled recording is
 * therefore named by its session id — under the runner's DejaVu fonts that
 * id is wider than the 3-up card and the ellipsis ate it.
 *
 * The gate can only see it where the font makes it clip, which is why this
 * arm does not measure width (jsdom has no layout): it pins the PROPERTY the
 * gate's finding is a symptom of — an id on screen is reachable in full —
 * across every scene, at every font, whether or not it happens to clip. */
describe('an opaque identifier on screen is never a dead end', () => {
  const check = (name: string, root: HTMLElement): void => {
    const unreachable: string[] = [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.children.length !== 0) continue; // own text only — leaves
      const text = (el.textContent ?? '').trim();
      if (!OPAQUE_ID.test(text) || isSecret(text)) continue;
      if (!reachable(el)) unreachable.push(`<${el.tagName.toLowerCase()}> "${text}"`);
    }
    expect(
      unreachable,
      `${name}: an id is rendered with no title on it or any of its six ancestors — ` +
        `truncate it (any font, any width) and the value is unrecoverable`,
    ).toEqual([]);
  };

  for (const name of MARKETING_SCENES) {
    it(`${name}: every id it renders carries a title`, () => {
      const restore = freezeHarnessClock();
      try {
        const { container } = render(<MarketingScene name={name} />);
        const stage = container.querySelector<HTMLElement>(`[data-scene="${name}"]`);
        expect(stage).not.toBeNull();
        if (stage !== null) check(name, stage);
      } finally {
        restore();
      }
    });
  }

  for (const name of AUDIT_SCENES) {
    it(`${name}: every id it renders carries a title`, async () => {
      const restore = freezeHarnessClock();
      try {
        const { container } = renderAudit(name);
        const stage = container.querySelector<HTMLElement>(`[data-scene="${name}"]`);
        expect(stage).not.toBeNull();
        if (stage === null) return;
        const markers = auditLoadedMarkers(name);
        await waitFor(
          () => expect(visibleStrings(stage).join('\n')).toContain(markers[markers.length - 1]),
          { timeout: 5_000 },
        );
        check(name, stage);
      } finally {
        restore();
      }
    });
  }

  it('the rule has teeth: the recording card the Linux gate caught is the shape it scans', () => {
    // Positive control — the id the gate reported, under the regex that
    // selects what must be reachable, and an untitled leaf that must fail.
    expect(OPAQUE_ID.test('ses_audit_berlin_price_watch')).toBe(true);
    expect(OPAQUE_ID.test('Amsterdam checkout')).toBe(false);
    expect(OPAQUE_ID.test('rec_audit_price_watch')).toBe(true);
    // …and the carve-out points the other way: a masked key is id-shaped,
    // and a title on it would publish the secret the mask exists to hide.
    expect(OPAQUE_ID.test('ds_live_example')).toBe(true);
    expect(isSecret('ds_live_example')).toBe(true);
    expect(isSecret('ses_audit_berlin_price_watch')).toBe(false);
    const bare = document.createElement('p');
    bare.textContent = 'ses_audit_berlin_price_watch';
    expect(reachable(bare)).toBe(false);
    const titled = document.createElement('p');
    titled.setAttribute('title', 'ses_audit_berlin_price_watch');
    expect(reachable(titled)).toBe(true);
  });
});
