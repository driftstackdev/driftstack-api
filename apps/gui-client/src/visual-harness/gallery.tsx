// Visual-check harness (2026-06-15) — renders the real ProfilePhoneCard across
// its meaningful states so an automated screenshot pass (repo-root
// scripts/gui-visual-check.mjs → Playwright → PNG) can review the actual rendered
// UI, not a mockup. NOT part
// of the shipped app: nothing imports this except visual-harness.html, which is
// not a build input (vite/Tauri bundle index.html only). Add new states here as
// the card grows so the visual review stays representative.

import type { JSX } from 'react';
import { ProfilePhoneCard, type ProfilePhoneCardProps } from '../components/ProfilePhoneCard';
import { ProfilesTable, type ProfileTableRow } from '../components/ProfilesTable';
import { CostPanel } from '../components/CostPanel';
import { SkeletonRows } from '../components/Skeleton';
import { ProxyForm } from '../views/ProxiesView';
import { DeviceToolbar } from '../views/SimulatorWindow';
import { Kpi } from '../views/CommandCenterView';
import { TierBadge } from '../components/TierBadge';
import { VPN_NOT_STORED_CHECK_NOTICE } from '../lib/proxy-check-copy';

const noop = (): void => undefined;

function base(over: Partial<ProfilePhoneCardProps>): ProfilePhoneCardProps {
  return {
    name: 'amsterdam shopper',
    monogram: 'AS',
    hue: 210,
    deviceLabel: 'iPhone 17',
    running: false,
    selected: false,
    lastUsedIso: '2026-06-15T06:30:00.000Z',
    folder: '',
    tags: [],
    hasProxy: true,
    proxyExplicit: true,
    // Polish — the default via row is the proxy's LABEL (the comp's); the
    // mono host:port fallback is the 'unnamed proxy' state's, which sets
    // proxyName: null explicitly.
    proxyName: 'Oxylabs residential NL #3',
    proxyAddress: 'gate.nodemaven.com:1080',
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    locationLabel: 'Amsterdam, North Holland',
    latencyMs: 42,
    latencyFillPct: 28,
    latencyGood: true,
    probed: true,
    capabilities: {
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 42,
      message: 'ok',
    },
    checkedAtIso: '2026-06-15T06:30:00.000Z',
    busy: false,
    launching: false,
    anyBusy: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    onToggleSelect: noop,
    onPrimary: noop,
    onWatch: noop,
    onTest: noop,
    onAssist: noop,
    onExport: noop,
    onDelete: noop,
    ...over,
  };
}

/** One SOCKS5 result that FAILS `proxyVerdict` (reaches + authenticates, cannot
 *  route) — the shape that trips the repair row. */
const CANNOT_ROUTE = {
  reachable: true,
  auth_ok: true,
  udp_associate: false,
  can_route: false,
  connect_reply: 0x05,
  latency_ms: 0,
  message: 'CONNECT refused by the proxy (reply 0x05 — connection refused)',
} as const;

/** The failure the state matrix names: the proxy did not answer at all. */
const NOT_REACHABLE = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'The proxy did not answer. Check the host and port, and that it is online.',
} as const;

const SIXTY_CHAR_NAME = 'amsterdam shopper for the netherlands christmas campaigns 26';
const EIGHTY_CHAR_NOTE =
  'Warm this one every Monday before 09:00 CET; the checkout flow rejects cold ones';
/** Phase B state 11 — a 45-char name (truncates at 178 and at 260). */
const FORTY_FIVE_CHAR_NAME = 'amsterdam shopper with a long descriptive nam';
const LONG_PROXY_NAME = 'Oxylabs residential NL rotating #3';
const LONG_PLACE = 'Amsterdam, North Holland, Netherlands';

// The meaningful visual states. Label each so the screenshot is self-describing.
// ⛔ EXPORTED: the jsdom guard in tests/unit/profile-phone-card.test.tsx renders
// EVERY state here and asserts the Launch control survives each one — a state
// added here is a state that guard covers, with no second list to keep in sync.
// Phase B — the gate (scripts/gui-visual-check.mjs) additionally asserts that
// every state is exactly 234px tall and that every region meets its budget, so
// a state added here is a state the geometry proof covers too.
export const STATES: ReadonlyArray<{ label: string; props: ProfilePhoneCardProps }> = [
  { label: 'idle · UDP ok', props: base({}) },
  {
    label: 'MAX · full egress + folder + tags + saved-tabs + note (overflow repro)',
    props: base({
      name: FORTY_FIVE_CHAR_NAME,
      folder: 'Shopping / Netherlands',
      tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
      savedTabsReopen: true,
      sizeLabel: '128 MB',
      locationLabel: LONG_PLACE,
      proxyName: LONG_PROXY_NAME,
      note: EIGHTY_CHAR_NOTE,
      onSaveNote: noop,
      onEdit: noop,
      onTrim: noop,
      onActivity: noop,
      osFingerprint: { os: 'macos-or-ios', confidence: 'high', reason: 'SYN/TTL 64, MSS 1460' },
    }),
  },
  {
    label: 'launching · proxy check',
    props: base({ busy: true, launching: true }),
  },
  {
    label: 'running · live',
    props: base({
      name: 'tokyo sneakers',
      monogram: 'TS',
      icon: '👟',
      hue: 320,
      running: true,
      runningSinceIso: new Date(Date.now() - 12 * 60_000).toISOString(),
      onStop: noop,
      flag: '🇯🇵',
      countryCode: 'JP',
      exitIp: '133.18.7.40',
      locationLabel: 'Tokyo',
      latencyMs: 88,
      latencyFillPct: 60,
    }),
  },
  {
    label: 'UDP fail (muted, never red)',
    props: base({
      name: 'berlin reviews',
      monogram: 'BR',
      hue: 28,
      flag: '🇩🇪',
      countryCode: 'DE',
      exitIp: '91.64.12.200',
      locationLabel: 'Berlin',
      latencyMs: 210,
      latencyFillPct: 95,
      latencyGood: false,
      capabilities: {
        reachable: true,
        auth_ok: true,
        udp_associate: false,
        can_route: true,
        connect_reply: 0x00,
        latency_ms: 210,
        message: 'no udp',
      },
    }),
  },
  {
    label: 'untested',
    props: base({
      name: 'sao paulo deals',
      monogram: 'SP',
      hue: 140,
      flag: '🇧🇷',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      probed: false,
      capabilities: null,
      checkedAtIso: null,
      lastUsedIso: null,
    }),
  },
  {
    label: 'no proxy',
    props: base({
      name: 'local sandbox',
      monogram: 'LS',
      hue: 0,
      hasProxy: false,
      proxyExplicit: true,
      proxyAddress: null,
      flag: '🌍',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: null,
      checkedAtIso: null,
    }),
  },
  {
    label: 'selected · folder + tags',
    props: base({
      name: 'a profile with a long enough name to clamp',
      monogram: 'LP',
      hue: 260,
      selected: true,
      folder: 'Shopping',
      tags: ['aged', 'verified'],
    }),
  },
  // ── Phase A (2026-09-11) — the states the grid measurement named. Each one
  // exists because a row in it painted past the 178px card before the fix.
  {
    label: 'failed · socks5 (Re-test + Change)',
    props: base({
      name: 'lisbon returns',
      monogram: 'LR',
      hue: 350,
      flag: '🇵🇹',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: NOT_REACHABLE,
      proxyName: LONG_PROXY_NAME,
      lastUsedIso: null,
      checkedAtIso: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      onEdit: noop,
    }),
  },
  {
    label: 'failed · socks5 · cannot route',
    props: base({
      name: 'porto returns',
      monogram: 'PR',
      hue: 340,
      flag: '🇵🇹',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: CANNOT_ROUTE,
      onEdit: noop,
    }),
  },
  {
    label: 'failed · socks5 · testing',
    props: base({
      name: 'lisbon returns',
      monogram: 'LR',
      hue: 350,
      flag: '🇵🇹',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: CANNOT_ROUTE,
      testing: true,
      onEdit: noop,
    }),
  },
  { label: 'healthy · testing', props: base({ testing: true }) },
  {
    label: 'vpn · idle (fleet latency)',
    props: base({
      name: 'zurich banking',
      monogram: 'ZB',
      hue: 190,
      flag: '🇨🇭',
      countryCode: 'CH',
      exitIp: '185.22.1.9',
      locationLabel: 'Zürich, Zurich',
      vpn: true,
      proxyName: 'ProtonVPN CH#42',
      proxyAddress: 'ch-42.protonvpn.net:51820',
      capabilities: null,
      quicProbe: true,
      latencyMs: 61,
      latencyFillPct: 40,
      latencyFromServer: true,
      latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-01' },
    }),
  },
  {
    label: 'vpn · tunnel down (failure + notice + 4 tags)',
    props: base({
      name: 'oslo classifieds',
      monogram: 'OC',
      hue: 80,
      flag: '🇳🇴',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: null,
      vpn: true,
      proxyName: 'Mullvad no-osl-wg-001',
      proxyAddress: '193.32.127.66:51820',
      vpnFailure:
        'The test Mac could not bring the tunnel up: handshake timed out after 20 s (no reply from 193.32.127.66:51820).',
      vpnNotice:
        'Tunnel test not run this time — a live session holds the tunnel. Showing the last result.',
      folder: 'Marketplaces',
      tags: ['classifieds', 'norway', 'aged', 'warm'],
      onEdit: noop,
    }),
  },
  {
    label: 'vpn · no verdict yet',
    props: base({
      name: 'madrid tickets',
      monogram: 'MT',
      hue: 40,
      flag: '🇪🇸',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: null,
      vpn: true,
      proxyName: 'Mullvad es-mad-wg-004',
      checkedAtIso: null,
      // Polish — the notice says 'Endpoint resolves.', so the row carries the
      // resolved pre-flight the grid would: the pill reads 'endpoint ok'.
      endpoint: { resolved: true, message: 'Resolved' },
      vpnNotice: VPN_NOT_STORED_CHECK_NOTICE,
    }),
  },
  {
    // (o) — the fleet brought the tunnel up and observed the exit but reported
    // no latency: the grid's green 'tunnel up · no latency'; the card's pill is
    // 'tunnel up' and the caps row shows what that reply measured.
    label: 'vpn · tunnel up, no latency',
    props: base({
      name: 'vienna listings',
      monogram: 'VL',
      hue: 300,
      flag: '🇦🇹',
      countryCode: 'AT',
      exitIp: '185.22.1.10',
      locationLabel: 'Vienna, Vienna',
      vpn: true,
      proxyName: 'ProtonVPN AT#7',
      proxyAddress: 'at-7.protonvpn.net:51820',
      capabilities: null,
      quicProbe: true,
      latencyMs: null,
      latencyFillPct: 0,
      latencyGood: false,
      latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-02' },
      endpoint: { resolved: true, message: 'Resolved' },
    }),
  },
  {
    // (o) — the endpoint does not resolve: red 'unresolved' (the resolver's
    // message as title), Re-check + Change, no exit, no Check VPN promise.
    label: 'vpn · endpoint unresolved',
    props: base({
      name: 'warsaw parcels',
      monogram: 'WP',
      hue: 20,
      flag: '🌍',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      latencyFillPct: 0,
      latencyGood: false,
      capabilities: null,
      vpn: true,
      proxyName: 'Mullvad pl-waw-wg-003',
      proxyAddress: 'pl-waw-wg-003.mullvad.net:51820',
      endpoint: {
        resolved: false,
        message: 'DNS lookup of pl-waw-wg-003.mullvad.net failed: no such host.',
      },
      onEdit: noop,
    }),
  },
  {
    label: 'exit probe failed',
    props: base({
      name: 'dublin support',
      monogram: 'DS',
      hue: 120,
      flag: '🇮🇪',
      countryCode: null,
      exitIp: null,
      exitProbeFailed: true,
      locationLabel: null,
      latencyMs: 77,
      latencyFillPct: 50,
    }),
  },
  {
    label: 'socks5 · server vantage',
    props: base({ latencyFromServer: true, latencyVantage: { measuredFrom: 'control_plane' } }),
  },
  {
    label: 'inherited default · 15-char IPv4 · unnamed proxy',
    props: base({
      proxyExplicit: false,
      proxyName: null,
      proxyAddress: '255.255.255.255:65535',
      exitIp: '255.255.255.255',
    }),
  },
  {
    label: 'ipv6 exit',
    props: base({ exitIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7334', locationLabel: null }),
  },
  {
    label: 'long proxy label',
    props: base({
      proxyName: 'Residential rotating pool — Amsterdam #04 (sticky 10 min, nodemaven)',
    }),
  },
  { label: 'note · 80 chars', props: base({ note: EIGHTY_CHAR_NOTE, onSaveNote: noop }) },
  { label: '60-char name', props: base({ name: SIXTY_CHAR_NAME, monogram: 'AS' }) },
  {
    label: 'long-names · 45-char name · long place · long proxy · default',
    props: base({
      name: FORTY_FIVE_CHAR_NAME,
      proxyName: LONG_PROXY_NAME,
      proxyAddress: '255.255.255.255:65535',
      proxyExplicit: false,
      locationLabel: LONG_PLACE,
      exitIp: '255.255.255.255',
    }),
  },
  {
    label: 'saved tabs · never launched',
    props: base({ savedTabsReopen: true, lastUsedIso: null }),
  },
];

/** Phase A — `?w=178|240|260` pins every phone card to that exact width, so the
 *  measurement gate (scripts/gui-visual-check.mjs) can assert geometry at the
 *  grid's real minimum instead of at whatever the viewport happens to divide
 *  into. The classes are spelled out so Tailwind's scanner emits them. */
const FIXED_WIDTH_CLASS: Readonly<Record<string, string>> = {
  '178': 'w-[178px]',
  '240': 'w-[240px]',
  '260': 'w-[260px]',
};
function fixedWidthClass(): string | null {
  if (typeof window === 'undefined') return null;
  const w = new URLSearchParams(window.location.search).get('w');
  if (w === null) return null;
  return FIXED_WIDTH_CLASS[w] ?? null;
}

export function Gallery(): JSX.Element {
  const fixedWidth = fixedWidthClass();
  return (
    <div className="min-h-screen bg-surface-base p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink-primary">
        ProfilePhoneCard — visual states
      </h1>
      <p className="mb-6 text-sm text-ink-secondary">
        Automated render for the geometry gate (scripts/gui-visual-check.mjs). Every tile is 234px
        tall at 178 / 240 / 260px; the gate measures each region against its budget, plain and
        hovered, and opens the ⋯ menu on the first and last card.
      </p>
      <div
        data-harness="phone-cards"
        data-fixed-width={fixedWidth ?? 'auto'}
        className={
          fixedWidth === null
            ? 'grid grid-cols-[repeat(auto-fill,minmax(178px,1fr))] gap-3'
            : 'flex flex-wrap items-start gap-3'
        }
      >
        {STATES.map((s) => (
          <div
            key={s.label}
            data-state={s.label}
            className={`flex flex-col gap-1 ${fixedWidth ?? ''}`}
          >
            <span className="truncate text-2xs uppercase tracking-wide text-ink-muted">
              {s.label}
            </span>
            <ProfilePhoneCard {...s.props} />
          </div>
        ))}
      </div>

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        ProfilesTable — list view
      </h1>
      <ProfilesTable
        rows={TABLE_ROWS}
        sortKey="name"
        sortDir="asc"
        onSort={noop}
        allSelected={false}
        onToggleSelectAll={noop}
        onToggleSelect={noop}
        onPrimary={noop}
        onWatch={noop}
        onStop={noop}
        onTest={noop}
        onEdit={noop}
        onClone={noop}
        onTrim={noop}
        onDelete={noop}
        onSaveNote={noop}
      />

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        BillingCostView — wrapper states (header / skeleton / ready)
      </h1>
      <div className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-ink-muted">loading (skeleton)</span>
        <BillingWrapperShell>
          <SkeletonRows rows={4} label="Loading cost breakdown…" />
        </BillingWrapperShell>
      </div>
      <div className="mt-4 flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-ink-muted">ready</span>
        <BillingWrapperShell>
          <CostPanel
            breakdown={{
              computeCents: 1840,
              storageCents: 120,
              egressCents: 640,
              emailCents: 15,
              llmCents: 2310,
              totalCents: 4925,
              thresholdState: 'between-soft-and-hard',
            }}
            billingCycle="2026-06"
          />
        </BillingWrapperShell>
      </div>

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        SimulatorWindow toolbar — idle · live · recording
      </h1>
      <div className="flex flex-wrap gap-10">
        <div className="w-72">
          <span className="mb-1 block text-2xs uppercase tracking-wide text-ink-muted">idle</span>
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="amsterdam shopper"
            running={false}
            keyboardVisible={false}
            onToggleKeyboard={noop}
          />
        </div>
        <div className="w-72 pb-48">
          <span className="mb-1 block text-2xs uppercase tracking-wide text-ink-muted">
            live session
          </span>
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="amsterdam shopper"
            running
            keyboardVisible={false}
            onToggleKeyboard={noop}
          />
        </div>
        <div className="w-72">
          <span className="mb-1 block text-2xs uppercase tracking-wide text-ink-muted">
            keyboard open
          </span>
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="amsterdam shopper"
            running
            keyboardVisible
            onToggleKeyboard={noop}
          />
        </div>
      </div>

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        ProxyForm — proxy type editor (socks5 / wireguard / openvpn)
      </h1>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-muted">socks5</span>
          <ProxyForm
            mode="add"
            initial={{
              label: '',
              scheme: 'socks5',
              host: '',
              port: 1080,
              username: null,
              password: null,
            }}
            onCancel={noop}
            onSave={noop}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-muted">wireguard</span>
          <ProxyForm
            mode="add"
            initial={{
              label: '',
              scheme: 'wireguard',
              host: '',
              port: 51820,
              username: null,
              password: null,
            }}
            onCancel={noop}
            onSave={noop}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-muted">openvpn</span>
          <ProxyForm
            mode="add"
            initial={{
              label: '',
              scheme: 'openvpn',
              host: '',
              port: 1194,
              username: null,
              password: null,
            }}
            onCancel={noop}
            onSave={noop}
          />
        </div>
      </div>

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        Command Center — Plan KPI (T-18)
      </h1>
      <p className="mb-3 text-sm text-ink-secondary">
        The plan tier is a category, so the Plan value is a TierBadge pill, not the big-number
        treatment that clipped &ldquo;Enterprise&rdquo; to &ldquo;Enterpr…&rdquo; at the card edge.
        A numeric KPI sits alongside for contrast.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi icon={<span>▦</span>} label="Profiles" value="3 / 10" />
        <Kpi
          icon={<span>✦</span>}
          label="Plan"
          value="Enterprise"
          valueNode={<TierBadge tier="enterprise" size="md" />}
        />
        <Kpi
          icon={<span>✦</span>}
          label="Plan"
          value="Agency"
          valueNode={<TierBadge tier="agency_manual" size="md" />}
        />
        <Kpi
          icon={<span>✦</span>}
          label="Plan"
          value="Free"
          valueNode={<TierBadge tier="free" size="md" />}
        />
      </div>
    </div>
  );
}

// Mirrors BillingCostView's header + layout chrome so the screenshot review
// matches the shipped wrapper (the view itself needs SettingsContext + the
// cost hook, which don't render headless). Keep in sync with BillingCostView.
function BillingWrapperShell({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div className="flex flex-col gap-4 rounded border border-surface-divider bg-surface-base p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <span className="section-label">Billing</span>
          <h2 className="mt-1 text-lg font-medium tracking-tight text-ink-primary">Usage & cost</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Metered usage and spend for the selected billing cycle.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink-secondary">Billing cycle</label>
          <select
            className="rounded border border-surface-divider bg-surface-input px-2 py-1 text-sm text-ink-primary"
            defaultValue="2026-06"
          >
            <option>2026-06</option>
          </select>
          <button type="button" className="btn-secondary">
            Refresh
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

const TABLE_ROWS: ReadonlyArray<ProfileTableRow> = [
  {
    id: '1',
    name: 'amsterdam shopper',
    icon: '🛒',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: true,
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    proxyAddress: '127.0.0.1:24000',
    locationLabel: 'Netherlands',
    probed: true,
    udp: 'ok',
    latencyMs: 42,
    folder: 'Shopping',
    tags: ['aged'],
    lastUsedIso: '2026-06-15T06:30:00.000Z',
    selected: false,
    busy: true,
    launching: true,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '4.2 MiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
  {
    id: '2',
    name: 'tokyo sneakers',
    deviceLabel: 'iPhone 17',
    running: true,
    hasProxy: true,
    flag: '🇯🇵',
    countryCode: 'JP',
    exitIp: '133.18.7.40',
    proxyAddress: 'gate.nodemaven.com:1080',
    locationLabel: 'Japan',
    probed: true,
    udp: 'ok',
    latencyMs: 88,
    folder: '',
    tags: [],
    lastUsedIso: '2026-06-14T20:00:00.000Z',
    selected: true,
    busy: false,
    launching: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '18.7 MiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
  {
    id: '3',
    name: 'berlin reviews',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: true,
    flag: '🇩🇪',
    countryCode: 'DE',
    exitIp: '91.64.12.200',
    proxyAddress: '10.0.0.5:1080',
    locationLabel: 'Germany',
    probed: true,
    udp: 'fail',
    latencyMs: 210,
    folder: 'Reviews',
    tags: ['warm'],
    lastUsedIso: null,
    selected: false,
    busy: false,
    launching: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '1.1 GiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
  {
    id: '4',
    name: 'sao paulo deals',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: true,
    flag: '🇧🇷',
    countryCode: 'BR',
    exitIp: null,
    proxyAddress: '127.0.0.1:24010',
    locationLabel: null,
    probed: false,
    udp: 'unknown',
    latencyMs: null,
    folder: '',
    tags: [],
    lastUsedIso: '2026-06-10T12:00:00.000Z',
    selected: false,
    busy: false,
    launching: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '—',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
  {
    id: '5',
    name: 'local sandbox',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: false,
    flag: '🌍',
    countryCode: null,
    exitIp: null,
    proxyAddress: null,
    locationLabel: null,
    probed: false,
    udp: 'unknown',
    latencyMs: null,
    folder: '',
    tags: [],
    lastUsedIso: null,
    selected: false,
    busy: false,
    launching: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '512.0 KiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
];
