// Visual-check harness (2026-06-15) — renders the real ProfilePhoneCard across
// its meaningful states so an automated screenshot pass (repo-root
// scripts/gui-visual-check.mjs → Playwright → PNG) can review the actual rendered
// UI, not a mockup. NOT part
// of the shipped app: nothing imports this except visual-harness.html, which is
// not a build input (vite/Tauri bundle index.html only). Add new states here as
// the card grows so the visual review stays representative.

import type { JSX } from 'react';
import { ProfilePhoneCard, type ProfilePhoneCardProps } from '../components/ProfilePhoneCard';

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
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    organizeOpen: false,
    organizeSlot: null,
    onToggleSelect: noop,
    onPrimary: noop,
    onWatch: noop,
    onOrganizeToggle: noop,
    onTest: noop,
    onAssist: noop,
    ...over,
  };
}

// The meaningful visual states. Label each so the screenshot is self-describing.
const STATES: ReadonlyArray<{ label: string; props: ProfilePhoneCardProps }> = [
  { label: 'idle · UDP ok', props: base({}) },
  {
    label: 'running · live',
    props: base({
      name: 'tokyo sneakers',
      monogram: 'TS',
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
    </div>
  );
}
