// A profile whose proxy is dead looked almost exactly like one never tested.
//
// The egress widget rendered "no exit IP" and a blank latency for a FAILED
// probe — the same shape as "untested" — so nothing on the card said the
// profile would not launch. The only retest lived in the overflow menu, which
// you have to already suspect the proxy to go looking in.
//
// Reported as: make it clear a proxy isn't working in profile management, so it
// can be retested or changed conveniently. All three parts are pinned here: it
// SAYS so, it names WHY, and both actions are on the card itself.
//
// The label comes from the shared `proxyVerdict`, so these arms also hold the
// card and the proxies page to the same words for the same verdict.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProfilePhoneCard } from '../../src/components/ProfilePhoneCard';
import type { ProxyTestResult } from '../../src/lib/proxies';

const ROUTES: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'Working — CONNECT succeeded.',
};

const base = {
  name: 'Ada',
  monogram: 'A',
  hue: 200,
  deviceLabel: 'iPhone 16',
  running: false,
  selected: false,
  lastUsedIso: null,
  folder: '',
  tags: [],
  hasProxy: true,
  proxyExplicit: true,
  flag: '🇳🇱',
  countryCode: 'NL',
  exitIp: null,
  latencyMs: null,
  latencyFillPct: 0,
  latencyGood: false,
  probed: true,
  checkedAtIso: null,
  busy: false,
  launching: false,
  anyBusy: false,
  testing: false,
  testDisabled: false,
  launchDisabled: false,
  onToggleSelect: () => undefined,
  onPrimary: () => undefined,
  onWatch: () => undefined,
  onTest: () => undefined,
};

const renderCard = (over: Partial<React.ComponentProps<typeof ProfilePhoneCard>> = {}) =>
  render(<ProfilePhoneCard {...base} {...over} />);

const banner = () => document.querySelector('[data-component="proxy-broken-banner"]');

describe('a broken proxy says so on the profile card', () => {
  it('CRITICAL a proxy that cannot ROUTE is reported as broken. It reaches the host and authenticates, so every weaker check calls it healthy — and the customer only finds out when the session dies at launch.', () => {
    renderCard({ capabilities: { ...ROUTES, can_route: false, message: 'CONNECT refused' } });
    expect(banner()).not.toBeNull();
    expect(screen.getByText('Cannot route')).toBeInTheDocument();
  });

  it('names WHY, using the same words as the proxies page — not reachable vs auth vs routing', () => {
    renderCard({ capabilities: { ...ROUTES, reachable: false } });
    expect(screen.getByText('Not reachable')).toBeInTheDocument();

    renderCard({ capabilities: { ...ROUTES, auth_ok: false } });
    expect(screen.getByText('Auth failed')).toBeInTheDocument();
  });

  it('a WORKING proxy shows no banner — the warning has to mean something when it appears', () => {
    renderCard({ capabilities: ROUTES });
    expect(banner()).toBeNull();
  });

  it('an UNTESTED proxy shows no banner either, so "broken" is never confused with "unknown"', () => {
    // This is the distinction the card could not previously draw.
    renderCard({ capabilities: null, probed: false });
    expect(banner()).toBeNull();
  });

  it('retest is one click ON the card, not buried in the overflow menu', () => {
    const onTest = vi.fn();
    renderCard({ capabilities: { ...ROUTES, can_route: false }, onTest });
    fireEvent.click(screen.getByRole('button', { name: 'Retest' }));
    expect(onTest).toHaveBeenCalledTimes(1);
  });

  it('the retest click does not also toggle the row it sits inside', () => {
    // The card body is itself clickable; without stopPropagation, asking to
    // retest would silently select the profile too.
    const onToggleSelect = vi.fn();
    renderCard({ capabilities: { ...ROUTES, can_route: false }, onToggleSelect });
    fireEvent.click(screen.getByRole('button', { name: 'Retest' }));
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it('offers Change alongside Retest, because a dead proxy often needs replacing rather than re-probing', () => {
    const onEdit = vi.fn();
    const onToggleSelect = vi.fn();
    renderCard({ capabilities: { ...ROUTES, can_route: false }, onEdit, onToggleSelect });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it('shows Testing… and disables the button while a probe is in flight', () => {
    renderCard({ capabilities: { ...ROUTES, can_route: false }, testing: true });
    expect(screen.getByRole('button', { name: 'Testing…' })).toBeDisabled();
  });
});
