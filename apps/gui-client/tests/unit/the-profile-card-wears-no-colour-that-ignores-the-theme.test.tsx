// Owner 2026-09-24, item 1 (verbatim): "GUI profiles grid view, we made this
// darker , which is fine, but on light mode, this stays extremely dark and
// barely visible text. Should match with light/dark theme."
//
// The surfaces are measured in the-profile-card-surfaces-follow-the-light-and-
// dark-theme.test.ts. This file guards what SITS on them: every colour utility
// on the card — its frame, the glass, the rows, the dock, the details sheet and
// the ⋯ menu — must be a theme token, never `white` / `black` / a hex literal.
// On HEAD the card carried a white hairline frame, white/3–10% fills on the
// dock, the ⋯ button, the Test / Change buttons and the note, a white/35
// selection ring, a white ink on the accent fill and a dark-only soft red
// (#fca5a5) — each one tuned for the dark glass, each one invisible or
// unreadable on a light card.
//
// What is NOT a colour claim and is allowed:
//   · shadows (`shadow-[…]`) — a shadow is neutral in both themes;
//   · the identity thumbnail (`[data-component="identity-thumb"]`): its fill is
//     the profile's own hue gradient, a literal by design, and its ink is chosen
//     against that literal (thumbRecipe), not against the theme.

import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';

function props(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
  return {
    name: 'amsterdam shopper',
    monogram: 'AS',
    hue: 200,
    deviceLabel: 'iPhone 17',
    running: false,
    selected: false,
    lastUsedIso: null,
    folder: '',
    tags: [],
    hasProxy: true,
    proxyExplicit: true,
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    latencyMs: 42,
    latencyFillPct: 30,
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
    ...over,
  };
}

const NOT_REACHABLE = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'The proxy did not answer.',
} as const;

/** A colour-bearing utility whose colour is `white`, `black`, or an arbitrary
 *  literal (`[#…]`, `[rgb(…)]`) — i.e. one colour for both themes. Variants
 *  (`hover:`, `group-hover:`, `enabled:`, `focus-visible:`) are stripped first. */
const LITERAL_COLOUR =
  /^(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|from|via|to|outline|divide|placeholder|decoration|fill|stroke|caret|accent)-(?:white|black|\[(?:#|rgba?\(|hsla?\())/;

function literalColours(root: Element): string[] {
  const hits: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (el.closest('[data-component="identity-thumb"]') !== null) continue;
    for (const cls of (el.getAttribute('class') ?? '').split(/\s+/)) {
      const base = cls.split(':').pop() ?? '';
      if (LITERAL_COLOUR.test(base)) {
        const who =
          el.getAttribute('data-component') ??
          el.getAttribute('data-action') ??
          el.getAttribute('aria-label') ??
          el.tagName.toLowerCase();
        hits.push(`${who}: ${cls}`);
      }
    }
  }
  return hits;
}

const STATES: ReadonlyArray<[string, Partial<ProfilePhoneCardProps>]> = [
  ['idle', {}],
  ['running', { running: true }],
  ['selected', { selected: true }],
  ['launching', { launching: true, busy: true }],
  ['broken proxy (repair row: Retest + Change)', { capabilities: NOT_REACHABLE, onEdit: vi.fn() }],
  ['never tested (Test button)', { probed: false, capabilities: null, latencyMs: null }],
  [
    'details sheet open, with a note',
    { detailsInitiallyOpen: true, note: 'warm up first', onSaveNote: vi.fn() },
  ],
];

describe('owner item 1 — every colour on the Profiles card is a theme token', () => {
  for (const [label, over] of STATES) {
    it(`${label}: no white / black / literal colour utility anywhere on the card`, () => {
      const { container } = render(<ProfilePhoneCard {...props(over)} />);
      const article = container.querySelector('article');
      expect(article).not.toBeNull();
      expect(literalColours(article as Element)).toEqual([]);
      cleanup();
    });
  }

  it('the ⋯ menu (portaled to the body) wears no literal colour either', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    fireEvent.click(container.querySelector('[aria-label="More actions"]') as Element);
    const menu = document.querySelector('[data-component="card-actions-menu"]');
    expect(menu).not.toBeNull();
    expect(literalColours(menu as Element)).toEqual([]);
    cleanup();
  });

  it('positive control: the detector finds a literal it is handed', () => {
    const div = document.createElement('div');
    div.innerHTML =
      '<span class="bg-white/[0.06]"></span><span class="hover:text-[#fca5a5]"></span><span class="bg-surface-raised text-ink-primary shadow-[0_3px_10px_rgba(0,0,0,0.4)]"></span>';
    expect(literalColours(div)).toEqual(['span: bg-white/[0.06]', 'span: hover:text-[#fca5a5]']);
  });
});
