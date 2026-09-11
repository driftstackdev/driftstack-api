// Phase C (2026-09-11) — the profile card's click-opened DETAILS SHEET and the
// portaled ⋯ menu.
//
// Phase B cut the tile to eight fixed rows and moved everything that did not fit
// into titles and '+N' pills. The owner approved the tile on the condition that
// nothing was LOST: every fact the pre-Phase-B card showed must still be
// reachable — by CLICK, never by hover — in one place, at full length, by the
// data attribute it always carried. That is the enumerating test below (one
// arm per fact: os fingerprint, checked-at, folder, every tag, note, vpn
// failure, vpn notice, last used, size, exit ip), and it is the reason every
// other arm exists: the sheet has to open, close, trap focus and give it back
// for those facts to count as reachable.
//
// ⛔ Each arm names the production line whose reversal reds it, so a green here
// is a claim about the component, not about the test.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ProfilePhoneCard,
  DEFAULT_CONTENT_WIDTH,
  visibleMeta,
  menuBoxFor,
  scrollSheetBody,
  MENU_MAX_HEIGHT_PX,
  MENU_VIEWPORT_EDGE_PX,
  MENU_MIN_HEIGHT_PX,
  SHEET_ARROW_STEP_PX,
  SHEET_PAGE_FALLBACK_PX,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';

const NAME = 'zurich banking';
const CHECKED_AT = '2026-06-15T06:30:00.000Z';
const LAST_USED = '2026-06-14T21:05:00.000Z';
const NOTE = 'Warm this one every Monday before 09:00 CET; the checkout flow rejects cold ones';
const FAILURE =
  'The test Mac could not bring the tunnel up: handshake timed out after 20 s (no reply from 193.32.127.66:51820).';
const NOTICE =
  'Tunnel test not run this time — a live session holds the tunnel. Showing the last result.';
const TAGS = ['banking', 'ch', 'aged', 'warm', 'checkout'] as const;
const REAL_OS = { os: 'macos-or-ios', confidence: 'high', reason: 'TTL 64, MSS 1460' } as const;

function props(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
  return {
    name: NAME,
    monogram: 'ZB',
    hue: 190,
    deviceLabel: 'iPhone 17',
    running: false,
    selected: false,
    lastUsedIso: null,
    folder: '',
    tags: [],
    hasProxy: true,
    proxyExplicit: true,
    proxyName: 'ProtonVPN CH#42',
    proxyAddress: 'ch-42.protonvpn.net:51820',
    flag: '🇨🇭',
    countryCode: 'CH',
    exitIp: '185.22.1.9',
    locationLabel: 'Zürich, Zurich',
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

/** ONE card carrying every pre-Phase-B fact at once: a VPN row (failure AND
 *  notice) whose control plane observed an OS fingerprint and whose live session
 *  reported an exit, with a note, a folder, five tags, a size and both stamps. */
function everything(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
  return props({
    vpn: true,
    capabilities: null,
    latencyMs: null,
    vpnFailure: FAILURE,
    vpnNotice: NOTICE,
    osFingerprint: REAL_OS,
    checkedAtIso: CHECKED_AT,
    lastUsedIso: LAST_USED,
    sizeLabel: '3.0 MiB',
    folder: 'Banking / Switzerland',
    tags: [...TAGS],
    note: NOTE,
    onSaveNote: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  });
}

const byComponent = (root: ParentNode, name: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-component="${name}"]`);
const sheetOf = (root: ParentNode): HTMLElement | null => byComponent(root, 'card-details-sheet');
const menu = (): HTMLElement =>
  document.querySelector('[data-component="card-actions-menu"]') as HTMLElement;
const glyph = (): HTMLElement => screen.getByLabelText(`Details for ${NAME}`);
const SRC = resolve(__dirname, '../../src');
const source = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');
/** Line, block and JSX comments out; newlines kept so nothing shifts. */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(
      /(^|[^:'"`])\/\/[^\n]*/g,
      (m, lead: string) => lead + m.slice(lead.length).replace(/[^\n]/g, ''),
    );

describe('THE enumerating test — every pre-Phase-B fact is in the sheet, by its existing data attribute', () => {
  it('os fingerprint · checked-at · folder · every tag · note · vpn failure · vpn notice · last used · size · exit ip — none reachable at full length on the resting tile, ALL reachable in the sheet after ONE click', () => {
    const { container } = render(<ProfilePhoneCard {...everything()} />);
    const article = container.querySelector('article') as HTMLElement;
    // At rest: no sheet, and the tile shows the CLAUSE of the failure, never
    // the sentence (Phase B's `vpnFailureClause`) — the fact is cut, which is
    // exactly why the sheet exists.
    expect(sheetOf(container)).toBeNull();
    // The clause IS on the tile (a missing row would make `?.textContent`
    // undefined and the inequality vacuous), and it is not the sentence.
    const restingFailure = byComponent(container, 'proxy-vpn-failure');
    expect(restingFailure).not.toBeNull();
    expect(restingFailure?.textContent).not.toBe(FAILURE);
    expect(FAILURE).toContain(restingFailure?.textContent ?? '\u0000');
    expect(byComponent(container, 'proxy-os-fingerprint')).toBeNull(); // a VPN caps row has no OS chip in mode 'repair'
    expect(byComponent(container, 'profile-size')).toBeNull();
    expect(byComponent(container, 'tags-row')).toBeNull();
    expect(container.textContent).not.toContain('185.22.1.9'); // the IP rides in the exit row's title

    fireEvent.click(glyph());
    const sheet = sheetOf(container) as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(article.contains(sheet), 'the sheet lives INSIDE the article').toBe(true);
    const inSheet = within(sheet);

    // One row per fact. Each `data-component` is the attribute the pre-Phase-B
    // card carried for that fact (scratchpad old-attrs inventory, 2026-09-11);
    // deleting that row from the sheet in ProfilePhoneCard.tsx reds its line.
    const facts: ReadonlyArray<{ fact: string; component: string; text: string }> = [
      { fact: 'os fingerprint', component: 'proxy-os-fingerprint', text: 'iOS/macOS' },
      {
        fact: 'checked-at',
        component: 'proxy-checked-at',
        text: new Date(CHECKED_AT).toLocaleString(),
      },
      { fact: 'folder', component: 'tags-row', text: '📁 Banking / Switzerland' },
      ...TAGS.map((tag) => ({ fact: `tag "${tag}"`, component: 'tags-row', text: tag })),
      { fact: 'note', component: 'profile-note', text: NOTE },
      { fact: 'vpn failure', component: 'proxy-vpn-failure', text: FAILURE },
      { fact: 'vpn notice', component: 'proxy-vpn-notice', text: NOTICE },
      {
        fact: 'last used',
        component: 'profile-last-used',
        text: new Date(LAST_USED).toLocaleString(),
      },
      { fact: 'size', component: 'profile-size', text: '3.0 MiB stored' },
      { fact: 'exit ip', component: 'exit-row', text: '185.22.1.9' },
    ];
    for (const f of facts) {
      const el = sheet.querySelector<HTMLElement>(`[data-component="${f.component}"]`);
      expect(
        el,
        `${f.fact}: [data-component="${f.component}"] missing from the sheet`,
      ).not.toBeNull();
      expect(el?.textContent ?? '', `${f.fact}: text`).toContain(f.text);
    }
    // The machine-readable stamps survive alongside the human ones.
    expect(byComponent(sheet, 'proxy-checked-at')?.getAttribute('data-checked-at')).toBe(
      CHECKED_AT,
    );
    expect(
      byComponent(sheet, 'proxy-checked-at')?.querySelector('time')?.getAttribute('dateTime'),
    ).toBe(CHECKED_AT);
    expect(
      byComponent(sheet, 'profile-last-used')?.querySelector('time')?.getAttribute('dateTime'),
    ).toBe(LAST_USED);
    // The full text is the ELEMENT's text, not a title: the failure and the
    // note are read, not hovered.
    expect(byComponent(sheet, 'proxy-vpn-failure')?.textContent).toBe(FAILURE);
    expect(byComponent(sheet, 'profile-note')?.textContent).toBe(NOTE);
    // Every tag, at full length, in one row (no '+N' tail inside the sheet).
    expect(inSheet.queryByText(/^\+\d+$/)).toBeNull();
    expect(byComponent(sheet, 'tags-row')?.querySelectorAll('span')).toHaveLength(1 + TAGS.length);
    // The OS fact carries its hint (the sheet's "OS fact AND hints").
    expect(byComponent(sheet, 'proxy-os-fingerprint')?.getAttribute('data-os-tone')).toBe('match');
    expect(
      byComponent(sheet, 'proxy-os-fingerprint')?.getAttribute('title')?.length,
    ).toBeGreaterThan(10);
    expect(byComponent(sheet, 'capability-hints')?.textContent).toMatch(/UDP via tunnel/);
    cleanup();
  });

  it('a SOCKS5 row lists the FULL capability set (ProxyCapabilityChips) plus the OS chip and every hint; the exit row of a probe-failed row says why', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({ osFingerprint: REAL_OS, quicMeasured: 'h3', checkedAtIso: CHECKED_AT })}
      />,
    );
    fireEvent.click(glyph());
    const sheet = sheetOf(container) as HTMLElement;
    // `ProxyCapabilityChips` in the sheet's Capabilities row: dropping it reds
    // both the container and the per-capability chips.
    const caps = byComponent(sheet, 'proxy-capabilities') as HTMLElement;
    expect(caps).not.toBeNull();
    expect(caps.querySelector('[data-capability="webrtc"][data-ok="true"]')).not.toBeNull();
    expect(caps.querySelector('[data-capability="quic"][data-ok="true"]')).not.toBeNull();
    expect(byComponent(sheet, 'proxy-os-fingerprint')?.textContent).toContain('iOS/macOS');
    const hints = byComponent(sheet, 'capability-hints') as HTMLElement;
    expect(hints.querySelectorAll('li').length).toBeGreaterThanOrEqual(3); // UDP, QUIC, OS
    expect(hints.textContent).toMatch(/UDP ✓ — /);
    expect(byComponent(sheet, 'exit-row')?.textContent).toContain('185.22.1.9');
    cleanup();
    const { container: failed } = render(
      <ProfilePhoneCard {...props({ exitIp: null, countryCode: null, exitProbeFailed: true })} />,
    );
    fireEvent.click(glyph());
    const exit = byComponent(sheetOf(failed) as HTMLElement, 'exit-row') as HTMLElement;
    expect(exit.textContent).toContain('exit geo unavailable');
    expect(exit.textContent).toContain('no traffic completed a round trip');
    cleanup();
  });
});

describe('C1 — the sheet opens by CLICK (ⓘ glyph, Details menu row), never by hover; ×, Escape and an outside pointer-down close it; focus is trapped and returns', () => {
  it('absent at rest; the ⓘ glyph (data-action="open-details", "Details for <name>") opens a role=dialog labelled by the name, focus moves in, aria-expanded flips; × closes it and focus returns to the glyph', () => {
    const { container } = render(<ProfilePhoneCard {...everything()} />);
    expect(sheetOf(container)).toBeNull();
    const opener = glyph();
    expect(opener.getAttribute('data-action')).toBe('open-details');
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(
      opener.closest('[data-region="meta"]'),
      "the glyph is the meta row's reserved 16px",
    ).not.toBeNull();
    fireEvent.click(opener);
    const sheet = sheetOf(container) as HTMLElement;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    const labelId = sheet.getAttribute('aria-labelledby') as string;
    expect(document.getElementById(labelId)?.textContent).toBe(NAME);
    expect(sheet.contains(document.activeElement), 'focus moved into the dialog').toBe(true);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    // The sheet covers the screen (dock included) exactly like the note editor.
    expect(sheet.className).toMatch(/(^|\s)absolute(\s|$)/);
    expect(sheet.className).toMatch(/(^|\s)inset-0(\s|$)/);
    expect(sheet.className).toMatch(/(^|\s)z-40(\s|$)/);
    expect(byComponent(container, 'phone-screen')?.contains(sheet)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(sheetOf(container)).toBeNull();
    expect(document.activeElement, 'focus returned to the opener').toBe(opener);
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    cleanup();
  });

  it('Escape inside the sheet closes it (focus back to the glyph); Escape anywhere on the document closes it too; an outside pointer-down closes it; a pointer-down INSIDE keeps it', () => {
    const { container } = render(<ProfilePhoneCard {...everything()} />);
    fireEvent.click(glyph());
    fireEvent.keyDown(sheetOf(container) as HTMLElement, { key: 'Escape' });
    expect(sheetOf(container)).toBeNull();
    expect(document.activeElement).toBe(glyph());

    fireEvent.click(glyph());
    expect(sheetOf(container)).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(sheetOf(container)).toBeNull();

    fireEvent.click(glyph());
    fireEvent.pointerDown(sheetOf(container) as HTMLElement);
    expect(sheetOf(container), 'inside is inside').not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(sheetOf(container)).toBeNull();
    cleanup();
  });

  it('hover opens nothing: no group-hover reveal class remains in the card source, and hovering the card leaves the sheet closed', () => {
    // FORCE_HOVER is inert for the card — the harness's hover pass measures the
    // same tile. A `group-hover:flex|block|opacity-100|pointer-events-auto`
    // token anywhere in ProfilePhoneCard.tsx is a hover-only reveal.
    // Comments are stripped first: the card's own comments NAME the removed
    // hover classes (they say what was deleted), and a scanner that reads its
    // subject's prose reports the fix as the defect.
    const src = stripComments(source('components/ProfilePhoneCard.tsx'));
    expect(src).not.toMatch(
      /group-hover:(flex|block|inline|grid|opacity-100|pointer-events-auto|visible)\b/,
    );
    // Positive control for the scan: the select indicator's hover COLOUR is a
    // group-hover token that is allowed (it reveals nothing).
    expect(src).toMatch(/group-hover:border-white\/70/);
    const { container } = render(<ProfilePhoneCard {...everything()} />);
    fireEvent.mouseEnter(container.querySelector('article') as HTMLElement);
    fireEvent.mouseOver(container.querySelector('article') as HTMLElement);
    expect(sheetOf(container)).toBeNull();
    cleanup();
  });

  it('the first ⋯ menu row is "Details" and opens the same sheet, closing the menu; focus returns to ⋯ on close', () => {
    render(<ProfilePhoneCard {...everything()} />);
    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    expect(menu().getAttribute('data-open')).toBe('true');
    const rows = Array.from(menu().querySelectorAll('button'));
    expect(rows[0]?.textContent?.trim()).toBe('ⓘDetails');
    expect(rows[0]?.getAttribute('data-action')).toBe('open-details-row');
    fireEvent.click(screen.getByLabelText(`Details — every fact about ${NAME}, in full`));
    expect(menu().getAttribute('data-open'), 'opening the sheet closes the menu').toBe('false');
    const sheet = sheetOf(document) as HTMLElement;
    expect(sheet).not.toBeNull();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(sheetOf(document)).toBeNull();
    expect(document.activeElement).toBe(more);
    cleanup();
  });

  it("exclusive overlays: opening the sheet closes the note editor; the sheet's note row opens the textarea and closes the sheet; opening the menu closes the sheet", () => {
    const { container } = render(<ProfilePhoneCard {...everything()} />);
    // Editor open → Details (menu row) → sheet, no textarea.
    fireEvent.click(screen.getByLabelText(`Edit the note on ${NAME}`));
    expect(screen.getByLabelText(`Note for ${NAME}`)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByLabelText(`Details — every fact about ${NAME}, in full`));
    expect(screen.queryByLabelText(`Note for ${NAME}`)).toBeNull();
    expect(sheetOf(container)).not.toBeNull();
    // Sheet's note row → textarea, sheet gone, textarea focused (not stolen back).
    fireEvent.click(screen.getByLabelText(`Note on ${NAME} — click to edit`));
    expect(sheetOf(container)).toBeNull();
    const textarea = screen.getByLabelText(`Note for ${NAME}`);
    expect((textarea as HTMLTextAreaElement).value).toBe(NOTE);
    expect(document.activeElement).toBe(textarea);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Sheet open → ⋯ → menu open, sheet gone.
    fireEvent.click(glyph());
    expect(sheetOf(container)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(menu().getAttribute('data-open')).toBe('true');
    expect(sheetOf(container)).toBeNull();
    cleanup();
  });

  it('focus is trapped: Tab from the last focusable wraps to ×, Shift+Tab from × wraps to the last, Shift+Tab from the dialog itself lands on the last; clicks inside never toggle selection', () => {
    const onToggleSelect = vi.fn();
    const { container } = render(<ProfilePhoneCard {...everything({ onToggleSelect })} />);
    fireEvent.click(glyph());
    const sheet = sheetOf(container) as HTMLElement;
    const close = screen.getByRole('button', { name: 'Close details' });
    const note = screen.getByLabelText(`Note on ${NAME} — click to edit`);
    expect(document.activeElement).toBe(sheet);
    // `trapTab` in ProfilePhoneCard.tsx: dropping the wrap leaves focus where
    // the browser default would take it (nowhere in jsdom) → each arm reds.
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(note);
    fireEvent.keyDown(sheet, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(note);
    fireEvent.click(sheet);
    fireEvent.click(byComponent(sheet, 'exit-row') as HTMLElement);
    expect(onToggleSelect).not.toHaveBeenCalled();
    cleanup();
  });

  it('the body is a focus stop (tabIndex 0, inside the ring between × and the note row) and the arrow/page keys scroll IT from anywhere in the sheet — never the grid behind it', () => {
    const { container } = render(<ProfilePhoneCard {...everything()} />);
    fireEvent.click(glyph());
    const sheet = sheetOf(container) as HTMLElement;
    const body = byComponent(sheet, 'card-details-body') as HTMLElement;
    const close = screen.getByRole('button', { name: 'Close details' });
    const note = screen.getByLabelText(`Note on ${NAME} — click to edit`);
    // `tabIndex={0}` on card-details-body in ProfilePhoneCard.tsx: without it
    // the body is no focus stop (FOCUSABLE lists `[tabindex]:not([tabindex="-1"])`),
    // the ring is × ↔ note, and a card WITHOUT a note button has × alone —
    // nothing under the first 192px reachable by keyboard.
    expect(body.getAttribute('tabindex')).toBe('0');
    close.focus();
    fireEvent.keyDown(sheet, { key: 'Tab' });
    // trapTab only wraps at the ends; in the middle the browser default moves
    // focus (nowhere in jsdom) — so the ring's ORDER is proved on the ends:
    // Shift+Tab from × lands on the LAST stop (note), never the body.
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(note);
    // The scroll: focus on the dialog node (where open puts it) → ArrowDown
    // moves the BODY's scrollTop by one step; PageDown by a page; ArrowUp
    // back; never under 0. The `scrollSheetBody(...) !== null → preventDefault`
    // branch of the sheet's onKeyDown is the production line: dropping it
    // leaves scrollTop at 0 (jsdom has no default scroll) and every arm reds.
    sheet.focus();
    expect(document.activeElement).toBe(sheet);
    expect(body.scrollTop).toBe(0);
    // fireEvent returns false when the handler called preventDefault.
    const downNotPrevented = fireEvent.keyDown(sheet, { key: 'ArrowDown' });
    expect(body.scrollTop).toBe(SHEET_ARROW_STEP_PX);
    expect(downNotPrevented, 'the grid behind the sheet must not scroll').toBe(false);
    fireEvent.keyDown(close, { key: 'PageDown' });
    expect(body.scrollTop).toBe(SHEET_ARROW_STEP_PX + SHEET_PAGE_FALLBACK_PX);
    fireEvent.keyDown(body, { key: 'ArrowUp' });
    expect(body.scrollTop).toBe(SHEET_PAGE_FALLBACK_PX);
    fireEvent.keyDown(sheet, { key: 'PageUp' });
    expect(body.scrollTop).toBe(0);
    fireEvent.keyDown(sheet, { key: 'ArrowUp' });
    expect(body.scrollTop).toBe(0);
    // A non-scroll key is not swallowed (Escape still closes; a letter passes).
    expect(fireEvent.keyDown(sheet, { key: 'a' })).toBe(true);
    cleanup();
    // The pure helper: a page is the body's clientHeight minus one step, never
    // under the jsdom fallback; a non-scroll key returns null and moves nothing.
    const tall = { clientHeight: 400, scrollTop: 10 } as HTMLElement;
    expect(scrollSheetBody(tall, 'PageDown')).toBe(10 + (400 - SHEET_ARROW_STEP_PX));
    expect(scrollSheetBody(tall, 'Enter')).toBeNull();
    expect(tall.scrollTop).toBe(10 + (400 - SHEET_ARROW_STEP_PX));
  });

  it('a card with NO note button: × and the body are the whole ring, and ArrowDown from the dialog still reaches the facts under the fold', () => {
    const { container } = render(
      <ProfilePhoneCard {...everything({ note: undefined, onSaveNote: undefined })} />,
    );
    fireEvent.click(glyph());
    const sheet = sheetOf(container) as HTMLElement;
    const body = byComponent(sheet, 'card-details-body') as HTMLElement;
    const close = screen.getByRole('button', { name: 'Close details' });
    expect(screen.queryByLabelText(`Note on ${NAME} — click to edit`)).toBeNull();
    // Shift+Tab from the dialog → the LAST stop is the body, not ×.
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(body);
    // Tab from the body (the last stop) wraps to ×.
    fireEvent.keyDown(sheet, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    sheet.focus();
    fireEvent.keyDown(sheet, { key: 'ArrowDown' });
    expect(body.scrollTop).toBe(SHEET_ARROW_STEP_PX);
    cleanup();
  });

  it('the ⓘ glyph is the 16px visibleMeta reserves: 1 glyph without a note, 2 with one — the meta row cuts one pill earlier when the note glyph joins', () => {
    const meta = {
      folder: 'Shopping / Netherlands',
      tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
    };
    // The pure rule at the jsdom width: 3 pills with one glyph, 2 with two.
    expect(visibleMeta(meta, DEFAULT_CONTENT_WIDTH, 1).pills).toHaveLength(3);
    expect(visibleMeta(meta, DEFAULT_CONTENT_WIDTH, 2).pills).toHaveLength(2);
    // The render reads it: `visibleMeta(p, contentWidth, hasNote ? 2 : 1)` in
    // ProfilePhoneCard.tsx — `hasNote ? 1 : 0` (the pre-Phase-C reserve) shows
    // 4 and 3 pills instead and reds both arms.
    const { container } = render(<ProfilePhoneCard {...props(meta)} />);
    const row = container.querySelector('[data-region="meta"]') as HTMLElement;
    expect(row.querySelectorAll('[title]:not([data-component]):not([data-action])')).toHaveLength(
      3,
    );
    expect(byComponent(row, 'tags-overflow')?.textContent).toBe('+3');
    expect(row.contains(glyph())).toBe(true);
    cleanup();
    const { container: noted } = render(
      <ProfilePhoneCard {...props({ ...meta, note: 'vip', onSaveNote: vi.fn() })} />,
    );
    const row2 = noted.querySelector('[data-region="meta"]') as HTMLElement;
    expect(row2.querySelectorAll('[title]:not([data-component]):not([data-action])')).toHaveLength(
      2,
    );
    expect(byComponent(row2, 'tags-overflow')?.textContent).toBe('+4');
    expect(row2.contains(glyph())).toBe(true);
    expect(row2.contains(screen.getByLabelText(`Edit the note on ${NAME}`))).toBe(true);
    cleanup();
  });
});

describe('C2 — the ⋯ menu is a PORTAL: fixed from the card rect, flipped by room, dismissal treats the portal node as inside', () => {
  it('while open the menu is a child of document.body, never a descendant of the article; role=group kept; aria-expanded toggles; Escape closes', () => {
    const { container } = render(<ProfilePhoneCard {...everything()} />);
    const article = container.querySelector('article') as HTMLElement;
    const more = screen.getByRole('button', { name: 'More actions' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    const m = menu();
    expect(m.getAttribute('data-open')).toBe('true');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    // `createPortal(…, document.body)` in ProfilePhoneCard.tsx: rendering the
    // menu inline again makes it a descendant of the article and reds this.
    expect(article.contains(m)).toBe(false);
    expect(m.parentElement).toBe(document.body);
    expect(m.getAttribute('role')).toBe('group');
    expect(m.className).toMatch(/(^|\s)fixed(\s|$)/);
    expect(more.getAttribute('aria-controls')).toBe(m.id);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(m.getAttribute('data-open')).toBe('false');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    cleanup();
  });

  it("a pointer-down on a portaled row is INSIDE (the menu stays open); a click on the menu's own padding never toggles selection; a grid scroll closes it, a scroll inside the menu does not", () => {
    const onToggleSelect = vi.fn();
    render(<ProfilePhoneCard {...everything({ onToggleSelect })} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const m = menu();
    fireEvent.pointerDown(screen.getByLabelText(`Edit ${NAME}`));
    expect(m.getAttribute('data-open'), 'a row is inside').toBe('true');
    fireEvent.click(m);
    expect(onToggleSelect).not.toHaveBeenCalled();
    expect(m.getAttribute('data-open')).toBe('true');
    // A scroll INSIDE the menu (an expanded Clear group scrolling its last row
    // into view) is not the grid scrolling.
    fireEvent.scroll(m);
    expect(m.getAttribute('data-open')).toBe('true');
    fireEvent.scroll(document);
    expect(m.getAttribute('data-open'), 'a fixed popover detached from its card closes').toBe(
      'false',
    );
    cleanup();
  });

  it('Tab / Shift+Tab inside the portaled menu CLOSE it and put focus back on ⋯ (the browser continues from there), instead of walking out of the portal to the end of document.body with the menu standing', () => {
    render(<ProfilePhoneCard {...everything()} />);
    const more = screen.getByRole('button', { name: 'More actions' });
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    const m = menu();
    expect(m.getAttribute('data-open')).toBe('true');
    fireEvent.keyDown(m, { key: 'End' });
    const last = document.activeElement as HTMLElement;
    expect(m.contains(last)).toBe(true);
    expect(last.getAttribute('aria-label')).toBe(`Delete ${NAME}`);
    // The `if (e.key === 'Tab')` arm of the menu's onKeyDown in
    // ProfilePhoneCard.tsx: without it Tab falls through (`which === null →
    // return`), the menu stays open and focus stays on the row (jsdom has no
    // default Tab) — both expectations red.
    // fireEvent returns false when the handler called preventDefault.
    const notPrevented = fireEvent.keyDown(last, { key: 'Tab' });
    expect(m.getAttribute('data-open')).toBe('false');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
    // NOT prevented: the browser's sequential navigation runs after dispatch
    // from ⋯ (focused now), so Tab lands on the control AFTER ⋯ — the next
    // card — and never on browser chrome past the portal.
    expect(notPrevented).toBe(true);
    // Shift+Tab from the FIRST row: same close, same landing.
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    expect(m.getAttribute('data-open')).toBe('true');
    const first = document.activeElement as HTMLElement;
    expect(first.getAttribute('aria-label')).toBe(`Details — every fact about ${NAME}, in full`);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(m.getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(more);
    cleanup();
  });

  it('menuBoxFor: inset 6px from both card edges; below → 6px under the card; above → 6px over the dock, in viewport coordinates', () => {
    const rect = (top: number, left: number, w: number, h: number): DOMRect => ({
      top,
      left,
      width: w,
      height: h,
      right: left + w,
      bottom: top + h,
      x: left,
      y: top,
      toJSON: () => ({}),
    });
    const article = {
      getBoundingClientRect: () => rect(100, 40, 178, 234),
    } as unknown as HTMLElement;
    const dock = {
      getBoundingClientRect: () => rect(100 + 234 - 7 - 47, 47, 164, 47),
    } as unknown as HTMLElement;
    // jsdom's innerHeight is 768: 768 − 340 − 8 = 420 ≥ 350 → the class cap.
    expect(menuBoxFor(article, dock, true)).toEqual({
      left: 46,
      width: 166,
      top: 340,
      maxHeight: MENU_MAX_HEIGHT_PX,
    });
    const above = menuBoxFor(article, dock, false);
    expect(above.left).toBe(46);
    expect(above.width).toBe(166);
    expect(above.top).toBeUndefined();
    // dock top = 280; the menu's bottom edge sits at 274 → bottom = innerHeight − 274.
    expect(above.bottom).toBe(window.innerHeight - 274);
    // 274 − 8 = 266 of room above → the cap drops under 350.
    expect(above.maxHeight).toBe(274 - MENU_VIEWPORT_EDGE_PX);
  });

  it("menuBoxFor clamps the box to the viewport: at the app's minimum window height (600) a top-row card's menu opening BELOW is capped to the room left, so its last rows scroll inside the menu instead of sitting under the viewport edge, unreachable (a grid scroll closes a fixed menu)", () => {
    const rect = (top: number, left: number, w: number, h: number): DOMRect => ({
      top,
      left,
      width: w,
      height: h,
      right: left + w,
      bottom: top + h,
      x: left,
      y: top,
      toJSON: () => ({}),
    });
    const originalHeight = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
      // First grid row: article 22..256 (card.bottom 256 → menu top 262).
      const article = {
        getBoundingClientRect: () => rect(22, 40, 178, 234),
      } as unknown as HTMLElement;
      const dock = {
        getBoundingClientRect: () => rect(22 + 234 - 7 - 47, 47, 164, 47),
      } as unknown as HTMLElement;
      // `clampMenuHeight(viewportHeight - top)` in menuBoxFor: dropping the clamp
      // (a constant 350) puts the 13-row menu's bottom at 262 + 344 = 606 > 600.
      const below = menuBoxFor(article, dock, true);
      expect(below.top).toBe(262);
      expect(below.maxHeight).toBe(600 - 262 - MENU_VIEWPORT_EDGE_PX);
      expect((below.top as number) + below.maxHeight).toBeLessThanOrEqual(
        600 - MENU_VIEWPORT_EDGE_PX,
      );
      // Above from the same row: 202 − 6 = 196 of room → 188.
      const above = menuBoxFor(article, dock, false);
      expect(above.maxHeight).toBe(196 - MENU_VIEWPORT_EDGE_PX);
      // Never a sliver: with 40px of room the cap stays at the floor (the flip
      // rule, not the clamp, keeps the menu off a short side).
      const low = {
        getBoundingClientRect: () => rect(320, 40, 178, 234),
      } as unknown as HTMLElement;
      expect(menuBoxFor(low, dock, true).maxHeight).toBe(MENU_MIN_HEIGHT_PX);
      expect(MENU_MIN_HEIGHT_PX).toBeLessThan(MENU_MAX_HEIGHT_PX);
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    }
  });

  it("the rendered menu carries the cap as an inline max-height (the class's 350 is only the ceiling)", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored verbatim in `finally`
    const original = HTMLElement.prototype.getBoundingClientRect;
    const originalHeight = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
      HTMLElement.prototype.getBoundingClientRect = () => ({
        top: 120,
        bottom: 256,
        left: 0,
        right: 178,
        width: 178,
        height: 136,
        x: 0,
        y: 120,
        toJSON: () => ({}),
      });
      render(<ProfilePhoneCard {...everything()} />);
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const m = menu();
      expect(m.getAttribute('data-placement')).toBe('below');
      expect(m.style.top).toBe('262px');
      // `maxHeight: menuBox.maxHeight` in the portal's style: dropping it leaves
      // the style empty and the class's 350 rules → 262 + 350 > 600.
      expect(m.style.maxHeight).toBe(`${String(600 - 262 - MENU_VIEWPORT_EDGE_PX)}px`);
      expect(m.className).toMatch(/max-h-\[350px\]/);
      cleanup();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    }
  });
});
