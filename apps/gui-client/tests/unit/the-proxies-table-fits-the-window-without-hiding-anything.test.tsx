// The Proxies grid fits its window, and it did not get there by hiding things.
//
// OWNER, on the eleven-column grid: "it has too many rows and its not very
// clean to move to need to go to left and right to see informatino, this needs
// better architecutre to more cleanly view and match screen. But still without
// removing useful information."
//
// MEASURED before the change: one <table> with `min-w-[880px]`, AUTO layout and
// six `whitespace-nowrap` columns, inside an `overflow-x-auto` box that is
// ~1008px wide at the default 1280 window and ~688px at the 960 minimum (the
// sidebar is a fixed 224px). Its real minimum width was content-driven and well
// past 880px, so it scrolled sideways at EVERY window size.
//
// The fix is consolidation, not column-dropping: eleven columns became six
// GROUPED ones under `table-fixed` + a <colgroup>, and a detail row under each
// proxy prints, in full and selectable, every value the merged cells shorten.
// These arms pin the two halves of that bargain:
//
//   FITS    — six header cells, `table-fixed`, no `min-w-[…]`.
//   NOTHING HIDDEN — all five sort keys are still buttons (the columns that
//             stopped being columns kept their names there), and the detail row
//             carries the endpoint, the username and the whole status sentence.
//
// jsdom does no layout, so "fits 688px" is not measurable here; what IS pinned
// is the mechanism that makes overflow impossible (fixed layout, no minimum
// width anywhere in the subtree, a width class on every <col> and the rules
// behind those classes) and the truncation hooks fixed layout needs. The
// measured budget is beside the `.ds-proxy-col-*` tiers in styles/index.css.
//
// MUTATIONS each arm catches are named on the arm.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGED_CHIP_CLASS, proxyCapabilities } from '../../src/components/ProxyCapabilities';
import { osFingerprintVerdict } from '../../src/lib/os-fingerprint-verdict';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import { CHECK_VPN_ACTION, VPN_UDP_NOT_MEASURED_TITLE } from '../../src/lib/proxy-check-copy';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';
import type { CachedProbe } from '../../src/lib/proxy-probe-cache';
import { MEASURED_READING_TTL_MS } from '../../src/lib/proxy-reading-windows';

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const confirmFn = vi.fn(() => Promise.resolve(true));

// Long enough that two clamped lines of a ~120px cell cannot hold it — the
// standing complaint was that this sentence was only ever readable in a hover.
const LONG_FAILURE =
  'The proxy closed the connection during the SOCKS5 greeting after 12 seconds; check that the address and the login are the ones your provider issued for this plan.';

const UNREACHABLE: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: LONG_FAILURE,
};

const LONG_LABEL =
  'Residential rotating pool — Frankfurt datacentre, shared with the checkout team (do not remove)';
const LONG_HOST =
  'gateway-eu-central-1.rotating.residential.proxy-provider-with-a-long-name.example.com';

function proxy(id: string, over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    id,
    label: `proxy-${id}`,
    host: `${id}.example.com`,
    port: 1080,
    username: `user-${id}`,
    password: 'never-rendered',
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme: 'socks5',
    ...over,
  };
}

let stored: ProxyConfig[] = [];
// What the view hydrates from on mount — server latency, vantage, exit, OS
// reading, fleet failure and the endpoint verdict of a VPN/HTTP row all arrive
// through this one map, exactly as they do in the app.
let cache: Record<string, CachedProbe> = {};

const REACHABLE: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0,
  latency_ms: 50,
  message: 'ok',
};
// The fail-closed `result` an endpoint (VPN/HTTP) cache entry carries.
const ENDPOINT_PLACEHOLDER: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: '',
};
const WG = {
  private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
  peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
  endpoint: 'wg.example.com:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.7.0.2/32',
};
function wireguard(id: string, label: string): ProxyConfig {
  return proxy(id, {
    label,
    scheme: 'wireguard',
    host: 'wg.example.com',
    port: 51820,
    username: null,
    password: null,
    serverId: `aprx_${id}`,
    wireguard: WG,
  });
}

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  // Spread the REAL module and override only the I/O — a hand-listed factory
  // silently omits every export added later.
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve(cache),
  saveExitResult: vi.fn(() => Promise.resolve()),
  saveProbeResult: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../src/components/ConfirmProvider', () => ({ useConfirm: () => confirmFn }));

const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

function table(): HTMLTableElement {
  const el = document.querySelector<HTMLTableElement>('[data-component="proxy-table"] table');
  if (el === null) throw new Error('the proxies table did not render');
  return el;
}

function detailRows(): HTMLElement[] {
  return [...table().querySelectorAll<HTMLElement>('tr[data-component="proxy-row-detail"]')];
}

function rowOrder(): string[] {
  return [...table().querySelectorAll('tr[data-component="proxy-row"]')].map(
    (tr) => tr.querySelector('[data-component="proxy-row-label"]')?.textContent ?? '',
  );
}

function detailValue(detail: HTMLElement, label: string): HTMLElement {
  const dt = [...detail.querySelectorAll('dt')].find((el) => el.textContent === label);
  const dd = dt?.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`no detail value for ${label}`);
  return dd;
}

function chevron(label: string): HTMLElement {
  return screen.getByRole('button', { name: `Show details for ${label}` });
}

describe('the proxies table fits the window without hiding anything', () => {
  beforeEach(() => {
    testProxy.mockReset();
    stored = [];
    cache = {};
  });

  it('(a) has exactly SIX header cells — eleven columns were merged, and a seventh would be the first step back to a sideways scroll', async () => {
    // MUTATION: re-add `<Th label="Endpoint" />` → 7.
    stored = [proxy('a')];
    render(<ProxiesView />);
    await screen.findByLabelText('Select proxy-a');
    const headers = within(table()).getAllByRole('columnheader');
    expect(headers).toHaveLength(6);
    // …and the <colgroup> that gives table-fixed its widths agrees with them.
    expect(table().querySelectorAll('colgroup > col')).toHaveLength(6);
    // Every body row has the same six cells (a detail row has ONE, spanning 6).
    const row = table().querySelector('tr[data-component="proxy-row"]');
    expect(row?.querySelectorAll('td')).toHaveLength(6);
  });

  it('(b) is table-fixed with NO minimum width anywhere inside it, a width on every column but the one that absorbs the rest, and the rules behind those widths', async () => {
    // MUTATION: put `min-w-[880px]` back — on the table, its box, or a div inside
    // a cell — or drop `table-fixed` → red. Either alone restores the overflow: a
    // minimum wider than the 688px box, or auto layout under which `truncate` is
    // inert and nowrap content sets the width.
    // MUTATION: drop a <col> class → table-fixed splits the columns EQUALLY and
    // Health loses the width its pill was measured against → red.
    stored = [proxy('a'), wireguard('w', 'wg-row')];
    render(<ProxiesView />);
    await screen.findByLabelText('Select proxy-a');
    const t = table();
    expect(t.className).toMatch(/(^|\s)table-fixed(\s|$)/);
    expect(t.className).toMatch(/(^|\s)w-full(\s|$)/);
    const shell = t.parentElement!;
    expect(shell.className).toMatch(/(^|\s)ds-table-shell(\s|$)/);
    // Fails SAFE: if some cell's content ever cannot wrap, the box scrolls to it
    // rather than cutting a control off with nothing on screen to say so.
    expect(shell.className).toMatch(/(^|\s)overflow-x-auto(\s|$)/);

    // No fixed or minimum pixel width above a chip's size ANYWHERE in the grid
    // (the 30px latency meter is the largest legitimate one), and no viewport
    // breakpoint — the box is the window minus the sidebar, so md:/lg: misfire.
    const root = document.querySelector<HTMLElement>('[data-component="proxy-table"]')!;
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      const cls = typeof el.className === 'string' ? el.className : '';
      for (const m of cls.matchAll(/(?:^|\s)(?:min-w|w)-\[(\d+(?:\.\d+)?)px\]/g)) {
        expect(Number(m[1]), `<${el.tagName.toLowerCase()} class="${cls}">`).toBeLessThanOrEqual(
          40,
        );
      }
      expect(cls, `<${el.tagName.toLowerCase()} class="${cls}">`).not.toMatch(
        /(^|\s)(sm|md|lg|xl|2xl):/,
      );
    }
    // No cell holds its column open any more: nowrap on a <td>/<th> is how the
    // old grid got wider than its box.
    const nowrapCells = [...t.querySelectorAll('td, th')].filter((c) =>
      /whitespace-nowrap/.test(c.className),
    );
    expect(nowrapCells).toHaveLength(0);

    // The column budget: five widths and ONE column (Health) with none.
    const cols = [...t.querySelectorAll('colgroup > col')].map((c) => c.getAttribute('class'));
    expect(cols).toEqual([
      'w-8',
      'ds-proxy-col-proxy',
      'ds-proxy-col-exit',
      'ds-proxy-col-network',
      null,
      'ds-proxy-col-actions',
    ]);
    // …and the classes are real: each has a base rule and a container tier, and
    // the tier is a CONTAINER query.
    const css = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8');
    for (const name of cols.filter((c): c is string => c !== null && c.startsWith('ds-'))) {
      const rules = css.match(new RegExp(`\\.${name} \\{\\s*width: [\\d.]+(px|%);`, 'g')) ?? [];
      expect(rules, `${name} needs a base width and a wide-tier width`).toHaveLength(2);
    }
    // PIN UPDATED 2026-09-17 — the wide tier now OPENS with a comment (why it was
    // rebalanced after looking at the render), so "the first thing inside the
    // block is the rule" stopped being true while the mechanism did not change.
    // What is pinned is still that the tier is a CONTAINER query holding the
    // column rule: nothing but comments and whitespace may sit between them.
    expect(css).toMatch(
      /@container \(min-width: 900px\) \{(?:\s|\/\*[\s\S]*?\*\/)*\.ds-proxy-col-proxy \{/,
    );
    expect(css).not.toMatch(/@media[^{]*\{[^}]*\.ds-proxy-col/);

    // …and the widths THEMSELVES, which the loop above accepts at any value.
    // Both tiers were tuned against the render, not derived: the narrow tier is
    // cut so Exit never truncates an exit IP and Health holds its longest pill;
    // the wide tier was rebalanced BY EYE so Network holds three chips on a line
    // and 190px keeps "Re-test · Edit · Remove" on one. A rebalance — or a revert
    // to the first cut, 21.4 / 15.9 / 13.3 / 172, which passed every measurement
    // and still looked wrong — has to come here and say why.
    // MUTATION: `.ds-proxy-col-network { width: 13.3% }` in the wide tier → red.
    const wideAt = css.indexOf('@container (min-width: 900px)');
    expect(wideAt).toBeGreaterThan(-1);
    const widths = (block: string): Record<string, string> =>
      Object.fromEntries(
        [...block.matchAll(/\.ds-proxy-col-([a-z]+) \{\s*width: ([\d.]+(?:px|%));/g)].map((m) => [
          m[1]!,
          m[2]!,
        ]),
      );
    expect(widths(css.slice(0, wideAt))).toEqual({
      proxy: '20.4%',
      exit: '17.5%',
      network: '15.4%',
      actions: '118px',
    });
    expect(widths(css.slice(wideAt))).toEqual({
      proxy: '18.5%',
      exit: '14.5%',
      network: '19%',
      actions: '190px',
    });
  });

  it('(c) keeps all FIVE sort keys reachable as buttons — each one ORDERS THE ROWS by its own key, marks itself pressed, sets aria-sort on its header cell, and keeps focus', async () => {
    // MUTATION: drop one entry from either `sorts` list → its getByRole throws.
    // MUTATION: wire a button to its NEIGHBOUR's key ({label:'Latency',
    // sortKey:'tested'}, {label:'Type', sortKey:'label'}) → the th still reads
    // 'ascending', because both keys live in it; the ROW ORDER is what goes red.
    // That is why every key below has an order no other key produces.
    // MUTATION: compute aria-sort from the th's FIRST key only → Latency and
    // Last test (2nd/3rd in their th) read 'none' after being clicked.
    // MUTATION: declare the header cell component inside ProxyTable again → it
    // remounts on every sort, the clicked button is a new node and focus drops.
    const now = Date.now();
    stored = [
      proxy('p1', { label: 'bravo' }),
      proxy('p2', { label: 'charlie', scheme: 'http', port: 8080 }),
      wireguard('p3', 'alpha'),
    ];
    cache = {
      // bravo — SOCKS5, healthy, the FASTEST (50ms native), tested MOST recently.
      p1: { result: REACHABLE, at: now - 1_000 },
      // charlie — HTTP: no latency is ever measured for it (sorts last), and its
      // address check is the OLDEST test.
      p2: {
        result: ENDPOINT_PLACEHOLDER,
        at: now - 3_000_000,
        endpoint: { resolved: true, ip: '198.51.100.2', message: 'resolves' },
      },
      // alpha — WireGuard, tunnel up but SLOW (200ms), tested in between.
      p3: {
        result: ENDPOINT_PLACEHOLDER,
        at: now - 2_000_000,
        endpoint: { resolved: true, ip: '198.51.100.3', message: 'resolves' },
        serverLatencyMs: 200,
        measuredFrom: 'fleet',
        nodeId: 'n1',
        serverProbeAt: now - 2_000_000,
      },
    };
    render(<ProxiesView />);
    await screen.findByLabelText('Select bravo');
    await screen.findByText('200ms');

    const button = (name: string): HTMLElement =>
      // A string `name` is a whole-string match, and the scope is the TABLE: the
      // "Sort by status" reset link above it is a different control.
      within(table()).getByRole('button', { name });
    const thOf = (name: string): HTMLElement => {
      const th = button(name).closest('th');
      if (th === null) throw new Error(`the ${name} sort button is not inside a header cell`);
      return th;
    };
    const pressed = (): string[] =>
      [...table().querySelectorAll('thead button[aria-pressed="true"]')].map(
        (b) => b.textContent?.replace(/[\u2191\u2193]/g, '').trim() ?? '',
      );

    // Grouping: Proxy + Type share a cell; Status + Latency + Last test share one.
    expect(thOf('Proxy')).toBe(thOf('Type'));
    expect(thOf('Status')).toBe(thOf('Latency'));
    expect(thOf('Status')).toBe(thOf('Last test'));
    expect(thOf('Proxy')).not.toBe(thOf('Status'));

    // The default sort is status ascending: slow (alpha) before unverified
    // (charlie) before healthy (bravo).
    expect(thOf('Status').getAttribute('aria-sort')).toBe('ascending');
    expect(thOf('Proxy').getAttribute('aria-sort')).toBe('none');
    expect(pressed()).toEqual(['Status']);
    expect(rowOrder()).toEqual(['alpha', 'charlie', 'bravo']);

    // Five keys, five DIFFERENT ascending orders — a button wired to any other
    // key cannot produce its own.
    const ascending = {
      Proxy: ['alpha', 'bravo', 'charlie'], // by label
      Type: ['charlie', 'bravo', 'alpha'], // http < socks5 < wireguard
      Latency: ['bravo', 'alpha', 'charlie'], // 50 < 200 < never measured
      'Last test': ['charlie', 'alpha', 'bravo'], // oldest first
      Status: ['alpha', 'charlie', 'bravo'],
    } as const;
    expect(new Set(Object.values(ascending).map((o) => o.join())).size).toBe(5);

    for (const [name, other] of [
      ['Proxy', 'Status'],
      ['Type', 'Status'],
      ['Latency', 'Proxy'],
      ['Last test', 'Proxy'],
      ['Status', 'Proxy'],
    ] as const) {
      const node = button(name);
      node.focus();
      fireEvent.click(node);
      await waitFor(() => expect(thOf(name).getAttribute('aria-sort')).toBe('ascending'));
      expect(thOf(other).getAttribute('aria-sort')).toBe('none');
      expect(rowOrder(), `${name} ascending`).toEqual(ascending[name]);
      // WHICH of the buttons sharing this th is the sort: exactly one, this one.
      expect(pressed()).toEqual([name]);
      // The header cell was updated, not remounted: same node, still focused.
      expect(button(name)).toBe(node);
      expect(document.activeElement).toBe(node);
      // A second click on the SAME key reverses it — the th follows the key
      // that is active, not merely "one of mine was clicked".
      fireEvent.click(node);
      await waitFor(() => expect(thOf(name).getAttribute('aria-sort')).toBe('descending'));
      expect(rowOrder(), `${name} descending`).toEqual([...ascending[name]].reverse());
      expect(pressed()).toEqual([name]);
    }
  });

  it('(d) the chevron opens a detail row that carries the endpoint, the username and the WHOLE status sentence — and closes it again', async () => {
    // MUTATION: drop the Username item (the row no longer prints it) → red.
    // MUTATION: clamp the detail's status sentence like the row's → the class
    // assertion below goes red.
    stored = [proxy('a')];
    testProxy.mockResolvedValueOnce(UNREACHABLE);
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
    await screen.findByText(LONG_FAILURE);

    // Closed: no detail row, and the username is not in the row any more.
    expect(detailRows()).toHaveLength(0);
    expect(screen.queryByText('user-a')).toBeNull();
    const toggle = chevron('proxy-a');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    await waitFor(() => expect(detailRows()).toHaveLength(1));
    const detail = detailRows()[0]!;
    // Directly under its row, one cell spanning all six columns.
    expect(detail.previousElementSibling?.getAttribute('data-component')).toBe('proxy-row');
    expect(detail.querySelectorAll('td')).toHaveLength(1);
    expect(detail.querySelector('td')?.getAttribute('colspan')).toBe('6');
    // aria-controls points at it.
    const open = screen.getByRole('button', { name: 'Hide details for proxy-a' });
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(open.getAttribute('aria-controls')).toBe(detail.id);

    const text = detail.textContent ?? '';
    expect(text).toContain('a.example.com:1080');
    expect(text).toContain('user-a');
    expect(text).toContain(LONG_FAILURE);
    expect(text).not.toContain('never-rendered');
    // The names of the columns that stopped being columns are the labels here.
    const labels = [...detail.querySelectorAll('dt')].map((dt) => dt.textContent);
    for (const l of [
      'Type',
      'Endpoint',
      'Username',
      'Exit IP',
      'Latency',
      'Capabilities',
      'OS',
      'Status',
      'Last test',
    ])
      expect(labels, `detail label ${l}`).toContain(l);

    // The sentence is clamped in the ROW and whole in the DETAIL.
    const copies = screen.getAllByText(LONG_FAILURE);
    expect(copies).toHaveLength(2);
    const inRow = copies.find((el) => !detail.contains(el));
    const inDetail = copies.find((el) => detail.contains(el));
    expect(inRow?.className).toMatch(/line-clamp-2/);
    expect(inDetail?.className ?? '').not.toMatch(/line-clamp|truncate/);
    // …and the detail is selectable where the row is not.
    expect(detail.querySelector('td')?.className).toMatch(/(^|\s)select-text(\s|$)/);

    fireEvent.click(open);
    await waitFor(() => expect(detailRows()).toHaveLength(0));

    // The clamped sentence has its OWN way to the whole text, in the cell the
    // reader is looking at — and, being a button, it does not select the row.
    const more = within(table()).getByRole('button', { name: 'Read in full' });
    expect(more.closest('td')).toBe(inRow?.closest('td'));
    fireEvent.click(more);
    await waitFor(() => expect(detailRows()).toHaveLength(1));
    expect(more.getAttribute('aria-controls')).toBe(detailRows()[0]!.id);
    expect(screen.getByLabelText<HTMLInputElement>('Select proxy-a').checked).toBe(false);
  });

  it('(e) clicking the chevron does NOT toggle the row selection — with the positive control that a click on the row body DOES', async () => {
    // MUTATION: make the chevron a <span role="button"> → the row handler's
    // closest('button, …') guard no longer matches and the box gets checked.
    stored = [proxy('a')];
    render(<ProxiesView />);
    // The explicit generic, NOT `as HTMLInputElement`: `eslint --fix` strips that
    // cast as an unnecessary assertion (the cast itself makes the generic infer
    // the type), which silently re-breaks `.checked` under the test tsconfig — and
    // because the pre-commit hook runs the fix, the change vanished from disk
    // twice and lint-staged refused the commit as empty.
    const box = await screen.findByLabelText<HTMLInputElement>('Select proxy-a');

    fireEvent.click(chevron('proxy-a'));
    await waitFor(() => expect(detailRows()).toHaveLength(1));
    expect(box.checked).toBe(false);
    expect(document.querySelector('[data-component="proxy-bulk-bar"]')).toBeNull();
    // Reading the detail row does not select either: it has no row handler.
    fireEvent.click(detailRows()[0]!.querySelector('dd')!);
    expect(box.checked).toBe(false);

    // POSITIVE CONTROL — the same assertion can go the other way in this
    // render, so the `false` above is a measurement and not a dead handler.
    const label = table().querySelector('[data-component="proxy-row-label"]')!;
    fireEvent.click(label);
    await waitFor(() => expect(box.checked).toBe(true));
    expect(document.querySelector('[data-component="proxy-bulk-bar"]')).not.toBeNull();
  });

  it('(f) CONTROL — a long label and a long host are truncated in the row (on a block child, inside a min-w-0 flex item) and in FULL in the detail row', async () => {
    // MUTATION: move `truncate` back onto the <td> as a max-width → red; under
    // table-fixed only a block child of a min-w-0 box shows an ellipsis.
    stored = [proxy('long', { label: LONG_LABEL, host: LONG_HOST })];
    render(<ProxiesView />);
    await screen.findByLabelText(`Select ${LONG_LABEL}`);

    const row = table().querySelector<HTMLElement>('tr[data-component="proxy-row"]')!;
    const labelEl = row.querySelector<HTMLElement>('[data-component="proxy-row-label"]')!;
    const endpointEl = row.querySelector<HTMLElement>('[data-component="proxy-row-endpoint"]')!;
    // The row still CONTAINS both values — shortened by CSS, not by the markup.
    expect(labelEl.textContent).toBe(LONG_LABEL);
    expect(endpointEl.textContent).toBe(`${LONG_HOST}:1080`);
    // The Type that used to be a column of its own sits beside the endpoint.
    expect(within(row).getByText('SOCKS5')).toBeTruthy();
    for (const el of [labelEl, endpointEl]) {
      expect(el.tagName).toBe('DIV');
      expect(el.parentElement?.className).toMatch(/(^|\s)min-w-0(\s|$)/);
    }
    expect(labelEl.className).toMatch(/(^|\s)truncate(\s|$)/);
    // PIN UPDATED 2026-09-17 — the endpoint no longer truncates as ONE run: a long
    // host ate the port first ("ams.proxy.example.com:10…"), and the port is the
    // half that tells two rows on one provider apart. The HOST truncates (a
    // min-w-0 child of a min-w-0 flex box); the PORT is shrink-0 and never does.
    // MUTATION: put `truncate` back on the endpoint box, or drop `shrink-0` from
    // the port → red.
    expect(endpointEl.className).toMatch(/(^|\s)min-w-0(\s|$)/);
    expect(endpointEl.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    const [hostEl, portEl] = [...endpointEl.children] as HTMLElement[];
    expect(endpointEl.children).toHaveLength(2);
    expect(hostEl!.textContent).toBe(LONG_HOST);
    expect(hostEl!.className).toMatch(/(^|\s)truncate(\s|$)/);
    expect(hostEl!.className).toMatch(/(^|\s)min-w-0(\s|$)/);
    expect(portEl!.textContent).toBe(':1080');
    expect(portEl!.className).toMatch(/(^|\s)shrink-0(\s|$)/);
    expect(portEl!.className).not.toMatch(/(^|\s)truncate(\s|$)/);

    fireEvent.click(chevron(LONG_LABEL));
    await waitFor(() => expect(detailRows()).toHaveLength(1));
    const detail = detailRows()[0]!;
    expect(detailValue(detail, 'Proxy').textContent).toBe(LONG_LABEL);
    expect(detailValue(detail, 'Endpoint').textContent).toBe(`${LONG_HOST}:1080`);
    // …and a hover on the shortened value says the whole of it, without a click.
    expect(labelEl.getAttribute('title')).toBe(LONG_LABEL);
    expect(endpointEl.getAttribute('title')).toBe(`${LONG_HOST}:1080`);
    // Nothing in the detail row shortens anything.
    for (const el of [detail, ...detail.querySelectorAll<HTMLElement>('*')]) {
      expect(el.className, `<${el.tagName.toLowerCase()}> in the detail row`).not.toMatch(
        /(^|\s)(truncate|line-clamp-\d+)(\s|$)/,
      );
    }
  });

  it('(g) the detail row of a MEASURED SOCKS5 proxy spells out what its chips and its latency line keep in a hover: every capability sentence, the OS explanation, the whole exit, both latency readings', async () => {
    // MUTATION: empty the Capabilities / OS / Latency <dd> (keep its <dt>) → red;
    // arm (d) reads the labels only.
    const now = Date.now();
    const osFingerprint = { os: 'linux', confidence: 'high', reason: 'ttl 64', at: now } as const;
    stored = [proxy('m')];
    cache = {
      m: {
        result: REACHABLE,
        at: now - 60_000,
        exitIp: '203.0.113.254',
        exitCountry: 'DE',
        exitAt: now - 60_000,
        exitCity: 'Frankfurt am Main',
        exitRegion: 'Hesse',
        exitTimezone: 'Europe/Berlin',
        exitAsnOrg: 'Example Carrier GmbH',
        serverLatencyMs: 1234,
        measuredFrom: 'fleet',
        nodeId: 'n1',
        serverProbeAt: now - 60_000,
        quicProbe: true,
        // PIN UPDATED 2026-09-17 — the relay verdict carries its own date now
        // (`quicProbeAt`); an undated one is not shown, exactly like an undated UDP verdict.
        quicProbeAt: now - 60_000,
        osFingerprint,
      },
    };
    render(<ProxiesView />);
    await screen.findByText('1234ms');
    const row = table().querySelector<HTMLElement>('tr[data-component="proxy-row"]')!;
    // The row keeps BOTH readings, each an unbreakable unit with its own hook.
    const readings = [...row.querySelectorAll<HTMLElement>('[data-latency-vantage]')];
    expect(readings.map((r) => r.getAttribute('data-latency-vantage'))).toEqual([
      'fleet',
      'this_mac',
    ]);
    expect(readings.map((r) => r.textContent)).toEqual([
      '1234msfrom Driftstack',
      '50msfrom this Mac',
    ]);
    for (const r of readings) expect(r.className).toMatch(/(^|\s)whitespace-nowrap(\s|$)/);

    fireEvent.click(chevron('proxy-m'));
    await waitFor(() => expect(detailRows()).toHaveLength(1));
    const detail = detailRows()[0]!;

    const caps = detailValue(detail, 'Capabilities').textContent ?? '';
    const expected = proxyCapabilities(REACHABLE, undefined, true);
    expect(expected.length).toBeGreaterThan(1);
    for (const c of expected) {
      expect(c.hint.length).toBeGreaterThan(0);
      expect(caps, `capability ${c.label}`).toContain(`${c.label} \u2014 ${c.hint}`);
    }
    expect(detailValue(detail, 'OS').textContent).toContain(
      osFingerprintVerdict(osFingerprint).hint,
    );
    expect(detailValue(detail, 'Exit IP').textContent).toBe('203.0.113.254');
    expect(detailValue(detail, 'Exit location').textContent).toContain('Frankfurt am Main, Hesse');
    expect(detailValue(detail, 'Exit timezone').textContent).toBe('Europe/Berlin');
    expect(detailValue(detail, 'Exit network').textContent).toBe('Example Carrier GmbH');
    const latency = detailValue(detail, 'Latency').textContent ?? '';
    expect(latency).toContain('1234ms from Driftstack');
    expect(latency).toContain('50ms from this Mac');
    expect(detailValue(detail, 'Last test').textContent).toMatch(/^Tested /);
  });

  it('(h) the detail row of a VPN proxy whose check RAN AND FAILED says so under Latency — never "not measured" — and an unmeasured UDP / QUIC reading stays unmeasured; an HTTP row prints the same dash its row does', async () => {
    // MUTATION: build the detail's latency line from `serverMissingShown` (null
    // for every row without a native side) → the VPN row has no line and falls
    // through to the fallback → red.
    // MUTATION: collapse vpnQuicReading's ok:null arm into the negative → red.
    const now = Date.now();
    const FLEET_FAILURE =
      'The tunnel did not come up: the peer did not answer the handshake within 20 seconds.';
    const RESOLVES = 'wg.example.com resolves to 198.51.100.23';
    stored = [wireguard('w', 'wg-down'), proxy('h', { label: 'http-row', scheme: 'http' })];
    cache = {
      w: {
        result: ENDPOINT_PLACEHOLDER,
        at: now - 60_000,
        endpoint: { resolved: true, ip: '198.51.100.23', message: RESOLVES },
        fleetFailureReason: FLEET_FAILURE,
        serverProbeAt: now - 60_000,
      },
    };
    render(<ProxiesView />);
    await screen.findByText(FLEET_FAILURE);

    fireEvent.click(chevron('wg-down'));
    fireEvent.click(chevron('http-row'));
    await waitFor(() => expect(detailRows()).toHaveLength(2));
    const vpn = detailRows().find((d) => d.id === 'proxy-detail-w')!;
    const http = detailRows().find((d) => d.id === 'proxy-detail-h')!;

    const latency = detailValue(vpn, 'Latency').textContent ?? '';
    expect(latency).not.toMatch(/not measured/i);
    expect(latency).toContain('no answer');
    expect(latency).toContain(FLEET_FAILURE);
    expect(detailValue(vpn, 'Address check').textContent).toBe(RESOLVES);
    const caps = detailValue(vpn, 'Capabilities').textContent ?? '';
    expect(caps).toContain(`UDP \u2014 ${VPN_UDP_NOT_MEASURED_TITLE}`);
    expect(caps).toContain(
      `QUIC \u2014 Not measured yet \u2014 run ${CHECK_VPN_ACTION} to test QUIC through this tunnel.`,
    );
    // The chips in the row say the same: unmeasured, not a negative.
    const vpnRow = vpn.previousElementSibling!;
    expect(vpnRow.querySelector('[data-component="vpn-udp-chip"]')?.getAttribute('data-ok')).toBe(
      'unmeasured',
    );
    expect(vpnRow.querySelector('[data-component="vpn-quic-chip"]')?.getAttribute('data-ok')).toBe(
      'unmeasured',
    );
    expect(detailValue(vpn, 'Status').textContent).toContain(FLEET_FAILURE);
    expect(detailValue(vpn, 'OS').textContent?.length ?? 0).toBeGreaterThan(10);

    // HTTP: no latency check exists for it, so no sentence promising one.
    expect(detailValue(http, 'Latency').textContent).toBe('\u2014');
    // Nothing in either detail row shortens anything.
    for (const d of [vpn, http])
      for (const el of [d, ...d.querySelectorAll<HTMLElement>('*')])
        expect(el.className).not.toMatch(/(^|\s)(truncate|line-clamp-\d+)(\s|$)/);
  });

  it('(i) AGED readings — a proxy checked hours ago shows what was found THEN, muted and dated, on both kinds of row; never "untested", and never in the tone of a current reading (except an Apple OS reading, which keeps its green in the aged chrome — owner 2026-09-24). An aged reading beside a failed check is not shown at all', async () => {
    // MUTATION: stop passing `aged` to VpnUdpChip / VpnQuicChip / ProxyCapabilityChips
    // in ProxyRow → the chips fall back to "unmeasured" / the inference → red.
    // MUTATION: drop the `vpnFailure === undefined` test on `aged` in ProxyRow → the
    // failed row grows a dated tick → red.
    const now = Date.now();
    // ⛔ PIN UPDATED 2026-09-17 — three hours is now INSIDE every one of these
    // readings' display windows: the relay verdict, the UDP verdict and the OS
    // fingerprint are all re-taken by the six-hourly automatic check, so their
    // window is derived from that cadence rather than from the live-session
    // verdict's thirty minutes. A three-hour-old reading renders CURRENT, which is
    // the point of the change, so this arm — which is about the AGED rendering —
    // needs an age that is really past the window.
    //
    // ⛔ (review) DERIVED AND RENAMED. It was left as `AGED_AGE = 9 * 60 *
    // 60_000`: the value moved and the name did not, so the constant read as three
    // hours in five fixtures and in assertions printing "9 h ago". Reconciling the
    // pin against the window meant disbelieving the name. One hour past the window,
    // computed from the window, so the fixture follows the constant the next time
    // the cadence moves.
    const AGED_AGE = MEASURED_READING_TTL_MS + 60 * 60_000;
    const vpnEntry = (over: Partial<CachedProbe>): CachedProbe => ({
      result: ENDPOINT_PLACEHOLDER,
      at: now - 60_000,
      endpoint: { resolved: true, ip: '198.51.100.23', message: 'ok' },
      quicProbe: true,
      quicProbeAt: now - AGED_AGE,
      udpProbe: false,
      udpProbeAt: now - AGED_AGE,
      ...over,
    });
    stored = [
      wireguard('w', 'wg-aged'),
      wireguard('f', 'wg-failed'),
      proxy('s', { label: 'socks-aged' }),
    ];
    cache = {
      w: vpnEntry({ serverLatencyMs: 80, measuredFrom: 'fleet', serverProbeAt: now - AGED_AGE }),
      f: vpnEntry({ fleetFailureReason: 'The tunnel did not come up.' }),
      s: {
        result: REACHABLE,
        at: now - 60_000,
        quicProbe: false,
        quicProbeAt: now - AGED_AGE,
        osFingerprint: {
          os: 'macos-or-ios',
          confidence: 'high',
          reason: 'r',
          observedVia: 'exit_ip',
          singleHostVantage: true,
          at: now - AGED_AGE,
        },
      },
    };
    render(<ProxiesView />);
    await screen.findByText('The tunnel did not come up.');
    const rowOf = (label: string): HTMLElement =>
      screen.getByText(label).closest<HTMLElement>('tr[data-component="proxy-row"]')!;

    const udp = rowOf('wg-aged').querySelector('[data-component="vpn-udp-chip"]')!;
    expect(udp.getAttribute('data-ok')).toBe('aged');
    expect(udp.getAttribute('data-aged-value')).toBe('false');
    expect(udp.textContent).toBe('\u2935UDP \u00b7 9 h ago');
    expect(udp.className).not.toContain('status-ready');
    expect(udp.getAttribute('title')).toBe(
      // No API key in this suite, so the hover names the button THIS row has.
      `Last checked 9 hours ago. Run ${CHECK_VPN_ACTION} to check it again. UDP did not work through this VPN then.`,
    );
    const quic = rowOf('wg-aged').querySelector('[data-component="vpn-quic-chip"]')!;
    expect(quic.getAttribute('data-ok')).toBe('aged');
    expect(quic.getAttribute('data-aged-value')).toBe('true');
    expect(quic.textContent).toBe('\u2713QUIC \u00b7 9 h ago');
    expect(quic.className).not.toContain('status-ready');

    // A SOCKS5 row: the QUIC chip and the OS chip, same treatment.
    const socksQuic = rowOf('socks-aged').querySelector('[data-capability="quic"]')!;
    expect(socksQuic.getAttribute('data-ok')).toBe('aged');
    expect(socksQuic.getAttribute('data-aged-value')).toBe('false');
    const os = rowOf('socks-aged').querySelector('[data-component="proxy-os-fingerprint"]')!;
    expect(os.getAttribute('data-ok')).toBe('aged');
    // ⛔ OWNER 2026-09-24 (item 9): an aged APPLE reading keeps its green, in the
    // aged chrome ("if it's a Apple, it should be green status"); any other aged
    // reading is still neutral.
    // (The fixture's reading is macOS/iOS, so: match, in the dashed aged chrome.)
    expect(os.getAttribute('data-os-tone')).toBe('match');
    expect(os.className).toContain('border-dashed');
    expect(os.textContent).toContain('9 h ago');

    // ⛔ Beside a FAILED check nothing aged is shown: the view drops every
    // Driftstack-measured value when a check says the proxy does not work.
    const failed = rowOf('wg-failed');
    expect(failed.querySelector('[data-ok="aged"]')).toBeNull();
    expect(failed.querySelector('[data-component="vpn-quic-chip"]')?.getAttribute('data-ok')).toBe(
      'unmeasured',
    );

    // The detail row prints the sentence the chip keeps in its hover.
    fireEvent.click(chevron('wg-aged'));
    await waitFor(() => expect(detailRows()).toHaveLength(1));
    const caps = detailValue(detailRows()[0]!, 'Capabilities').textContent ?? '';
    expect(caps).toContain('UDP \u2014 Last checked 9 hours ago.');
    expect(caps).toContain('QUIC \u2014 Last checked 9 hours ago.');
    expect(caps).not.toMatch(/Not measured yet/);
  });
  it('(j) READABLE — nothing on the tab is set below the size the text-quality gate accepts, no ink carries an alpha, no text in the rendered table sits under an `opacity-NN`, the unmeasured chips wear an ink that clears their wash, and an aged chip may break only in THIS table, below the wide tier', async () => {
    // scripts/gui-text-quality.mjs measures the RENDERED tab (font size, and the
    // contrast of each ink composited on its real background) and found 32
    // findings here the day a scene first mounted this view: 8px machine chips,
    // `opacity-60` readings at 3.0:1 / 2.5:1, ink-muted on the divider wash at
    // 3.88:1, a `/80` status label at 4.15:1. jsdom paints nothing, so what is
    // pinned is the MECHANISM each of those came from, against the gate's own
    // minimum — read from the gate, so the two cannot drift apart.
    // MUTATION: `text-[8px]` back on READING_CHIP_CLS → red. `opacity-60` back on
    // a missing reading, OR on any wrapper above one → red. `bg-surface-divider/60`
    // back on UNMEASURED_CHIP_CLS → red. `text-status-ready/80` back on the
    // pool-stat label → red.
    const root = resolve(__dirname, '../../../..');
    const gate = readFileSync(resolve(root, 'scripts/gui-text-quality.mjs'), 'utf8');
    const minPx = Number(/const MIN_PX = (\d+);/.exec(gate)?.[1]);
    expect(minPx).toBeGreaterThanOrEqual(9);

    // The SOURCE half — sizes and alpha inks, over the code with its comments
    // taken out WHOLE (block, JSX-block and line comments: the ones beside these
    // classes NAME the old values, and a filter that only knew a comment's first
    // line went red or green with how its prose happened to wrap).
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    // CONTROL: the stripper takes a multi-line comment and leaves the code.
    expect(stripComments("a /* text-[8px]\n opacity-60 */ 'text-[9px]' // text-[7px]\n")).toBe(
      "a  'text-[9px]' \n",
    );
    for (const file of ['src/views/ProxiesView.tsx', 'src/components/ProxyCapabilities.tsx']) {
      const code = stripComments(readFileSync(resolve(__dirname, '../..', file), 'utf8'));
      const sizes = [...code.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
      // CONTROL: the scan sees arbitrary sizes at all — these files are full of them.
      expect(sizes.length, file).toBeGreaterThan(0);
      expect(
        sizes.filter((px) => px < minPx),
        file,
      ).toEqual([]);
      // An ink with an alpha is an opacity hack by another name.
      expect(code.match(/text-(?:ink|status)-[a-z-]+\/\d+/g) ?? [], file).toEqual([]);
    }

    // The DOM half — the two defects a source scan cannot see, because the class
    // that dims and the text it dims need not share a line, a string or an
    // element: the gate multiplies every `opacity` UP THE TREE into the ink, and
    // the original bug was exactly that, `opacity-60` on the whole reading. So:
    // a row of every kind, WITH the missing reading that carried it.
    stored = [
      wireguard('w', 'wg-new'),
      proxy('h', { label: 'http-new', scheme: 'http', username: null, password: null }),
      proxy('s', { label: 'socks-one-side' }),
      proxy('f', { label: 'socks-failed' }),
    ];
    cache = {
      s: { result: REACHABLE, at: Date.now() - 1_000 },
      f: { result: UNREACHABLE, at: Date.now() - 2_000 },
    };
    render(<ProxiesView />);
    await screen.findByLabelText('Select wg-new');
    // CONTROL: the reading that was dimmed is on screen.
    await waitFor(() =>
      expect(table().querySelectorAll('[data-latency-missing]').length).toBeGreaterThan(0),
    );
    fireEvent.click(chevron('socks-failed'));
    await waitFor(() => expect(detailRows()).toHaveLength(1));

    const dims = (el: Element): string[] => [
      ...[...el.classList].filter((c) => /^opacity-(?!0$)\d+$/.test(c)),
      ...(el instanceof HTMLElement && el.style.opacity !== ''
        ? [`style:${el.style.opacity}`]
        : []),
    ];
    // CONTROL: the detector fires on the bare utility and an inline style, and
    // not on a variant (`disabled:opacity-50` only applies to a disabled control,
    // which the gate exempts) or on `opacity-0`.
    const probe = document.createElement('span');
    probe.className = 'opacity-60 disabled:opacity-50 opacity-0';
    probe.style.opacity = '0.5';
    expect(dims(probe)).toEqual(['opacity-60', 'style:0.5']);

    const shell = table().closest('[data-component="proxy-table"]')!;
    const textBearing = [...shell.querySelectorAll<HTMLElement>('*')].filter((el) =>
      [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== ''),
    );
    expect(textBearing.length).toBeGreaterThan(30);
    const dimmed: string[] = [];
    for (const el of textBearing) {
      for (
        let a: Element | null = el;
        a !== null && a !== shell.parentElement;
        a = a.parentElement
      ) {
        const d = dims(a);
        if (d.length > 0)
          dimmed.push(`"${(el.textContent ?? '').slice(0, 30)}" under ${d.join(' ')}`);
      }
    }
    expect(dimmed).toEqual([]);

    // The wash and its ink, on whatever element carries them: ink-muted clears
    // 4.5 on the divider wash only up to /30 (4.74 dark; /40 is 4.44, /60 3.88).
    const washed = [...shell.querySelectorAll<HTMLElement>('*')].filter((el) =>
      [...el.classList].some((c) => /^bg-surface-divider\/\d+$/.test(c)),
    );
    for (const el of washed) {
      const alpha = Number(
        /^bg-surface-divider\/(\d+)$/.exec(
          [...el.classList].find((c) => c.startsWith('bg-surface-divider/'))!,
        )![1],
      );
      if (el.classList.contains('text-ink-muted')) {
        expect(alpha, el.textContent ?? '').toBeLessThanOrEqual(30);
      }
    }

    // …and the three chips nobody has measured, by name: on a VPN row and an
    // HTTP row with no reading at all.
    const unmeasured = [
      ...table().querySelectorAll<HTMLElement>('[data-ok="unmeasured"]'),
      // The HTTP row's Network cell (the status pill says "untested" too).
      ...[
        ...screen
          .getByText('http-new')
          .closest('tr')!
          .children[3]!.querySelectorAll<HTMLElement>('span'),
      ].filter((el) => el.textContent === 'untested'),
    ];
    expect(unmeasured.length).toBeGreaterThanOrEqual(3);
    for (const chip of unmeasured) {
      expect(washed, chip.textContent ?? '').toContain(chip);
      expect(chip.className, chip.textContent ?? '').toMatch(/(^|\s)bg-surface-divider\/30(\s|$)/);
      expect(chip.className, chip.textContent ?? '').toMatch(/(^|\s)text-ink-muted(\s|$)/);
    }

    // The aged chip: one phrase everywhere (nowrap), except in THIS table below
    // the wide tier, where the Network column is narrower than the longest of
    // them and the unbroken chip was painted over the Health column.
    expect(AGED_CHIP_CLASS).toMatch(/(^|\s)whitespace-nowrap(\s|$)/);
    expect(AGED_CHIP_CLASS).toMatch(/(^|\s)ds-proxy-aged-chip(\s|$)/);
    const css = stripComments(
      readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8'),
    );
    // ONE rule names the class, and its whole selector is pinned: it is scoped by
    // the proxies grid's own hook. AGED_CHIP_CLASS is shared — the profiles list
    // draws its aged UDP chip with it, inside a `.ds-table-shell` of its own — so
    // a selector hung on `.ds-table-shell` (the first cut) let THAT chip break too,
    // between a 720 and a 900px list. The glyph is a flex item of its own: on the
    // baseline it sits beside the first line instead of floating between the two.
    // MUTATION: `.ds-table-shell .ds-proxy-aged-chip` → red.
    const agedRules = [...css.matchAll(/([^{}]*\.ds-proxy-aged-chip[^{]*)\{([^}]*)\}/g)].map(
      (m) => [m[1]!.trim(), m[2]!.replace(/\s+/g, ' ').trim()],
    );
    expect(agedRules).toEqual([
      [
        "[data-component='proxy-table'] .ds-proxy-aged-chip",
        'white-space: normal; text-wrap: balance; align-items: baseline;',
      ],
    ]);
    // …inside the narrow container tier and nowhere else.
    expect(css).toMatch(
      /@container \(max-width: 899\.98px\) \{\s*\[data-component='proxy-table'\] \.ds-proxy-aged-chip \{/,
    );
    // The hook the selector leans on is the one this table renders, and the table
    // — with every chip in it — is inside it.
    expect(shell.getAttribute('data-component')).toBe('proxy-table');
    expect(shell.contains(table())).toBe(true);

    // …and the OTHER user of the class is outside that hook: the profiles list
    // never renders it, so the rule cannot reach its aged chip.
    const profilesTable = readFileSync(
      resolve(__dirname, '../../src/components/ProfilesTable.tsx'),
      'utf8',
    );
    expect(profilesTable).toContain('AGED_CHIP_CLASS');
    expect(stripComments(profilesTable)).not.toMatch(/proxy-table/);
  });
});
