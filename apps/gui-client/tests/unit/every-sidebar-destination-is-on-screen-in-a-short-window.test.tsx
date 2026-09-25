/* eslint-disable @typescript-eslint/require-await */
// gui-v0.1.72 follow-up (2026-09-25): at full width in a 1061×700 window the
// sidebar's nav SCROLLED and Settings sat below the fold (the release check's
// A1-nav-light-1061x700.png). A destination you cannot see is one you do not
// know exists.
//
// When the nav's layout does not fit the height it is given, the next denser
// one is used — `tight` (26px rows, closer groups, labels kept), then `folded`
// (the group labels become hairline dividers) — so every destination is on
// screen down to a 1060×640 window, and the account footer (email, plan, the
// figures, Sign out) is untouched.
//
// jsdom lays nothing out, so the heights are the harness's own MEASUREMENTS
// (audit-sessions at ?stage=1061x700 / 1061x640 / 1280x800, the fixture account
// with Team and Your servers — eleven destinations): the nav's room is the
// sidebar minus 175px of search row, footer and padding, and its content is
// 521 / 441 / 340px in the roomy / tight / folded layouts. The screenshots at
// those sizes are the proof that the layouts are what these numbers say.

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AccountSelfProfile } from '@driftstack/sdk';
import { Sidebar } from '../../src/components/Sidebar';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    async get(): Promise<null> {
      return null;
    }
    async set(): Promise<void> {}
    async save(): Promise<void> {}
  },
}));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
}));

const ACCOUNT = {
  id: 'acct_1',
  email: 'op@driftstack.test',
  name: null,
  tier: 'team_manual',
  status: 'active',
  timezone: null,
  slug: null,
  region: null,
  avatar_url: null,
  mfa_enrolled: false,
  concurrent_session_cap: 3,
  concurrent_session_active: 1,
  profile_cap: 10,
  profile_count: 8,
  teams: [],
  onboarding_completed_at: null,
} as unknown as AccountSelfProfile;

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    // A self-hosted base URL, so "Your servers" is on the list too.
    settings: {
      apiKey: 'ds_live_test',
      baseUrl: 'https://driftstack.example.com',
      telemetryOptIn: null,
    },
    accountMe: ACCOUNT,
    client: null,
    refreshAccountMe: vi.fn(),
    update: vi.fn(),
    loading: false,
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  }),
}));
vi.mock('../../src/lib/recordings', () => ({
  useRecordings: () => ({ recordings: new Map(), activeIds: new Set<string>() }),
}));
vi.mock('../../src/lib/proxies', () => ({
  listProxyMetadata: vi.fn(async () => []),
}));
vi.mock('../../src/lib/active-agent-sessions', () => ({
  fetchActiveAgentSessionCount: vi.fn(async () => 0),
}));

/** Measured in the harness at full width (see the header). */
const CHROME = 175;
const CONTENT = { roomy: 521, tight: 441, folded: 340 } as const;
const DESTINATIONS = [
  'Command center',
  'Profiles',
  'Proxies',
  'AI Browser Automation',
  'Saved tasks',
  'Session log',
  'Recordings',
  'Your servers',
  'Team',
  'Billing',
  'Settings',
];

let asideHeight = 0;
const observers: Array<() => void> = [];
class ControlledResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(): void {
    observers.push(() => this.cb([], this));
    this.cb([], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const isNav = (el: HTMLElement): boolean =>
  el.tagName === 'NAV' && el.getAttribute('aria-label') === 'Primary';

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.row === 'true' ? 1061 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === 'ASIDE') return asideHeight;
    return isNav(this) ? asideHeight - CHROME : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!isNav(this)) return 0;
    const density = (this.closest('aside')?.getAttribute('data-sidebar-density') ??
      'roomy') as keyof typeof CONTENT;
    return Math.max(CONTENT[density], asideHeight - CHROME);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A window `h` tall: the sidebar is `h` less the 36px title bar. */
function renderAt(h: number): HTMLElement {
  asideHeight = h - 36;
  render(
    <div data-row="true" style={{ display: 'flex' }}>
      <Sidebar
        current="profiles"
        onNavigate={vi.fn()}
        onSignOut={vi.fn()}
        onOpenPalette={vi.fn()}
      />
    </div>,
  );
  const aside = document.querySelector('aside');
  if (aside === null) throw new Error('no sidebar');
  return aside;
}

function resizeTo(h: number): void {
  asideHeight = h - 36;
  act(() => {
    for (const fire of observers) fire();
  });
}

function everyDestinationAndTheFooter(): void {
  const nav = screen.getByRole('navigation', { name: 'Primary' });
  for (const name of DESTINATIONS) {
    expect(within(nav).getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
  }
  expect(screen.getByText('op@driftstack.test')).toBeInTheDocument();
  expect(screen.getByText('Team plan')).toBeInTheDocument();
  expect(screen.getByText('8 / 10')).toBeInTheDocument();
  expect(screen.getByText('1 / 3')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Sign out/ })).toBeInTheDocument();
}

describe('every sidebar destination is on screen in a short window', () => {
  it('at 1280×800 the roomy layout fits and is kept: group labels, 30px rows', () => {
    const aside = renderAt(800);
    expect(aside.dataset.sidebarDensity).toBe('roomy');
    expect(screen.getByText('Browse')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' }).className).toContain('py-[7px]');
    everyDestinationAndTheFooter();
  });

  it('CRITICAL at 1061×700 — where Settings sat below the fold — the rows tighten and the labels stay', () => {
    const aside = renderAt(700);
    expect(aside.dataset.sidebarDensity).toBe('tight');
    expect(screen.getByText('Browse')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' }).className).toContain('py-[5px]');
    // The layout on screen fits the room it is given: nothing below the fold.
    expect(CONTENT.tight).toBeLessThanOrEqual(700 - 36 - CHROME);
    everyDestinationAndTheFooter();
  });

  it('CRITICAL at 1061×640 the group labels fold into dividers — each group keeps its name for a screen reader — and every destination and the footer are on screen', () => {
    const aside = renderAt(640);
    expect(aside.dataset.sidebarDensity).toBe('folded');
    expect(screen.queryByText('Browse')).toBeNull();
    for (const group of ['Home', 'Browse', 'Automate', 'History', 'Self-hosted', 'Account']) {
      expect(screen.getByRole('group', { name: group })).toBeInTheDocument();
    }
    expect(CONTENT.folded).toBeLessThanOrEqual(640 - 36 - CHROME);
    everyDestinationAndTheFooter();
  });

  it('the roomier layouts come back as the window grows, and never take turns at a boundary', () => {
    const aside = renderAt(640);
    expect(aside.dataset.sidebarDensity).toBe('folded');
    resizeTo(700);
    expect(aside.dataset.sidebarDensity).toBe('tight');
    // One pixel short of what the roomy layout needs: it stays tight, however
    // many times it is measured.
    resizeTo(36 + CHROME + CONTENT.roomy - 1);
    for (let i = 0; i < 5; i += 1) resizeTo(36 + CHROME + CONTENT.roomy - 1);
    expect(aside.dataset.sidebarDensity).toBe('tight');
    resizeTo(36 + CHROME + CONTENT.roomy);
    expect(aside.dataset.sidebarDensity).toBe('roomy');
    resizeTo(800);
    expect(aside.dataset.sidebarDensity).toBe('roomy');
  });

  it('VACUITY: a sidebar that is not laid out (0 — jsdom with no stubs) keeps the roomy layout', () => {
    const aside = renderAt(36);
    expect(aside.dataset.sidebarDensity).toBe('roomy');
  });
});
