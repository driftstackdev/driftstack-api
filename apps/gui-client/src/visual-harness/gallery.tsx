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
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    latencyMs: 42,
    latencyFillPct: 28,
    latencyGood: true,
    probed: true,
    capabilities: {
      reachable: true,
      auth_ok: true,
      udp_associate: true,
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

// The meaningful visual states. Label each so the screenshot is self-describing.
const STATES: ReadonlyArray<{ label: string; props: ProfilePhoneCardProps }> = [
  { label: 'idle · UDP ok', props: base({}) },
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
      flag: '🇯🇵',
      countryCode: 'JP',
      exitIp: '133.18.7.40',
      latencyMs: 88,
      latencyFillPct: 60,
    }),
  },
  {
    label: 'UDP fail (red)',
    props: base({
      name: 'berlin reviews',
      monogram: 'BR',
      hue: 28,
      flag: '🇩🇪',
      countryCode: 'DE',
      exitIp: '91.64.12.200',
      latencyMs: 210,
      latencyFillPct: 95,
      latencyGood: false,
      capabilities: {
        reachable: true,
        auth_ok: true,
        udp_associate: false,
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
      countryCode: 'BR',
      exitIp: null,
      latencyMs: null,
      probed: false,
      capabilities: null,
    }),
  },
  {
    label: 'no proxy',
    props: base({
      name: 'local sandbox',
      monogram: 'LS',
      hue: 0,
      hasProxy: false,
      flag: '🌍',
      countryCode: null,
      exitIp: null,
      latencyMs: null,
      capabilities: null,
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
];

export function Gallery(): JSX.Element {
  return (
    <div className="min-h-screen bg-surface-base p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink-primary">
        ProfilePhoneCard — visual states
      </h1>
      <p className="mb-6 text-sm text-ink-secondary">
        Automated render for self-review (scripts/visual-check.mjs). Hover states are forced on via
        the harness so the action strip + WebRTC/QUIC detail are visible in the static shot.
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(178px,1fr))] gap-3">
        {STATES.map((s) => (
          <div key={s.label} className="flex flex-col gap-1">
            <span className="text-2xs uppercase tracking-wide text-ink-muted">{s.label}</span>
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
