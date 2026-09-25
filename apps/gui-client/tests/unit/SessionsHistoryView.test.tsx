// SessionsHistoryView had ZERO coverage — 15 functions, none executed — while
// being a live lazily-routed view (App.tsx renders it) AND the reference other
// views cite: RecipesView says it "mirrors the SessionsHistoryView state-machine
// shape", SessionsView says it "mirrors SessionsHistoryView's success path".
// The pattern two siblings copy was the one nothing exercised.
//
// Found by measuring gui-client coverage for the first time. Worth recording that
// the first measurement was WRONG — run from inside apps/gui-client it collects
// only the 176 `.test.tsx` files and misses the 82 `.test.ts` ones, reporting a
// long list of "never executed" files whose tests simply had not run. This view
// is one of only three genuinely at 0% once measured correctly, and the other two
// are artifacts (the Tauri entry point and a visual harness).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
// The real wire schema, so a fixture cannot express a value the producer
// is incapable of emitting. See the note at its first use below.
import { EgressCapabilitiesSchema } from '@driftstack/api-types';

const sessionsList = vi.fn<() => Promise<{ data: unknown[] }>>(() => Promise.resolve({ data: [] }));
let ctx: { client: { sessions: { list: typeof sessionsList } } | null } = {
  client: { sessions: { list: sessionsList } },
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ctx,
}));

const { SessionsHistoryView } = await import('../../src/views/SessionsHistoryView');

function session(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ses_x',
    status: 'destroyed',
    // Every real row carries its device slug; the row renders it as the device
    // name ("iPhone 17"), the same label every other surface uses.
    archetype: 'iphone17_ios18_7_safari26_4',
    created_at: '2026-01-01T00:00:00Z',
    destroyed_at: null,
    last_state_at: null,
    ...over,
  };
}

beforeEach(() => {
  ctx = { client: { sessions: { list: sessionsList } } };
  sessionsList.mockReset();
  sessionsList.mockResolvedValue({ data: [] });
});
afterEach(cleanup);

describe('SessionsHistoryView', () => {
  it('without a configured client it asks for an API key instead of calling the API', () => {
    ctx = { client: null };
    render(<SessionsHistoryView />);
    expect(screen.getByText(/Set up your API key in Settings/i)).toBeTruthy();
    expect(sessionsList).not.toHaveBeenCalled();
  });

  it('lists ONLY terminated sessions — an active one is not history', async () => {
    sessionsList.mockResolvedValue({
      data: [
        session({ id: 'ses_live', status: 'active' }),
        session({ id: 'ses_gone', status: 'destroyed', destroyed_at: '2026-06-01T00:00:00Z' }),
        session({ id: 'ses_bad', status: 'errored', last_state_at: '2026-06-02T00:00:00Z' }),
      ],
    });
    render(<SessionsHistoryView />);
    await waitFor(() => expect(screen.getByText('ses_gone')).toBeTruthy());
    expect(screen.getByText('ses_bad')).toBeTruthy();
    expect(screen.queryByText('ses_live')).toBeNull();
  });

  // ⭐ The documented behaviour, and the one a naive "sort by destroyed_at" would
  // break. An errored session often has NO destroyed_at because the box never ran
  // a clean teardown; keying on that alone sends every such session to time 0 and
  // dumps the reasonless errors at the bottom, which is the opposite of useful for
  // a post-mortem view. The fallback chain interleaves them by when they ENDED.
  it('orders newest-first by when a session ended, falling back past a missing destroyed_at', async () => {
    sessionsList.mockResolvedValue({
      data: [
        session({ id: 'ses_oldest', status: 'destroyed', destroyed_at: '2026-06-01T00:00:00Z' }),
        // No destroyed_at — must sort by last_state_at, ABOVE the older destroyed one.
        session({
          id: 'ses_newest_errored',
          status: 'errored',
          last_state_at: '2026-06-03T00:00:00Z',
        }),
        session({ id: 'ses_middle', status: 'destroyed', destroyed_at: '2026-06-02T00:00:00Z' }),
      ],
    });
    const { container } = render(<SessionsHistoryView />);
    await waitFor(() => expect(screen.getByText('ses_newest_errored')).toBeTruthy());
    const text = container.textContent ?? '';
    const order = ['ses_newest_errored', 'ses_middle', 'ses_oldest'].map((id) => text.indexOf(id));
    expect(
      order.every((i) => i >= 0),
      'all three rendered',
    ).toBe(true);
    expect(order, 'newest-first, errored interleaved rather than sunk to the bottom').toEqual(
      [...order].sort((a, b) => a - b),
    );
  });

  it('an unparseable timestamp sorts last instead of throwing', async () => {
    sessionsList.mockResolvedValue({
      data: [
        session({ id: 'ses_nan', status: 'errored', last_state_at: 'not-a-date' }),
        session({ id: 'ses_ok', status: 'destroyed', destroyed_at: '2026-06-01T00:00:00Z' }),
      ],
    });
    const { container } = render(<SessionsHistoryView />);
    await waitFor(() => expect(screen.getByText('ses_ok')).toBeTruthy());
    const text = container.textContent ?? '';
    expect(text.indexOf('ses_ok')).toBeLessThan(text.indexOf('ses_nan'));
  });

  it('a failed load shows humanised copy, never the raw exception', async () => {
    sessionsList.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.driftstack.dev'));
    render(<SessionsHistoryView />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).not.toContain('ENOTFOUND');
    expect(alert.length).toBeGreaterThan(0);
  });

  it('no terminated sessions renders the empty state, not a blank panel', async () => {
    sessionsList.mockResolvedValue({ data: [session({ id: 'ses_live', status: 'active' })] });
    const { container } = render(<SessionsHistoryView />);
    await waitFor(() => expect(sessionsList).toHaveBeenCalled());
    await waitFor(() => expect((container.textContent ?? '').length).toBeGreaterThan(20));
    expect(screen.queryByText('ses_live')).toBeNull();
  });
});

describe('a history row names the session instead of showing only its id', () => {
  // Owner 2026-08-31: "a completely useless page right now with no logs nothing,
  // just session names like ses_43814912331". `label`, `purpose` and
  // `egress_capabilities` were in every payload this view already fetched and
  // none of them was rendered — the raw id was shown INSTEAD of the name.

  it('renders the label as the title and keeps the id as secondary', async () => {
    sessionsList.mockResolvedValue({
      data: [
        session({
          id: 'ses_labelled',
          label: 'Checkout smoke run',
          status: 'destroyed',
          destroyed_at: '2026-08-31T10:00:00.000Z',
        }),
      ],
    });
    render(<SessionsHistoryView />);
    expect(await screen.findByText('Checkout smoke run')).toBeTruthy();
    // The id must survive — it is what support and the SDK ask for.
    expect(screen.getByText('ses_labelled')).toBeTruthy();
  });

  it('says "Untitled session" rather than falling back to the id as a name', async () => {
    sessionsList.mockResolvedValue({
      data: [
        session({
          id: 'ses_unlabelled',
          label: null,
          status: 'destroyed',
          destroyed_at: '2026-08-31T10:00:00.000Z',
        }),
      ],
    });
    render(<SessionsHistoryView />);
    expect(await screen.findByText('Untitled session')).toBeTruthy();
    expect(screen.getByText('ses_unlabelled')).toBeTruthy();
  });

  it('surfaces egress warnings the harness reported and nothing showed', async () => {
    sessionsList.mockResolvedValue({
      data: [
        session({
          id: 'ses_leaky',
          label: 'Leaky run',
          status: 'destroyed',
          destroyed_at: '2026-08-31T10:00:00.000Z',
          // ⛔ THIS FIXTURE USED TO SAY `quic_route: true`, WHICH IS NOT A MEMBER
          // OF THAT ENUM. The helper above takes `Record<string, unknown>`, so an
          // impossible value typechecks, and the arm below then proved a branch
          // (`c.quic_route === false`) that no real payload could ever reach. A
          // consumer-side test cannot establish reachability on its own: the
          // question is what the PRODUCER can emit, not what this function will
          // accept. It is parsed through the real wire schema below for that
          // reason — an impossible fixture now reds here instead of certifying a
          // dead branch.
          //
          // ⚠️ `dns_remote_resolve: false` IS schema-valid but is NOT producible
          // today: the sole writer hardcodes `true` because nothing measures it
          // per session. The branch it exercises is correct code above a broken
          // writer, so this keeps it alive and honest rather than pretending the
          // warning is reachable in production. See the note in egressWarnings.
          egress_capabilities: EgressCapabilitiesSchema.parse({
            udp_associate: false,
            quic_route: 'disabled',
            dns_remote_resolve: false,
            warnings: [],
          }),
        }),
      ],
    });
    render(<SessionsHistoryView />);
    // DNS resolved outside the proxy is the classic proxy leak; it was collected,
    // stored, and rendered nowhere, so a leaking session looked exactly like a
    // clean one. The line reads in the customer's words (no 'UDP associate').
    const line = await screen.findByText(/DNS resolved outside the proxy/);
    expect(line.textContent).toContain('Connection limits: UDP not supported');
    expect(line.textContent).not.toMatch(/associate|egress/i);
    // ⛔ THE BRANCH THAT WAS DEAD. `quic_route` is a string enum and the check
    // compared it against `false`, so this warning could not appear for any
    // payload — including this one, whose route really is disabled. It only
    // looked covered because the old fixture put a boolean in that field.
    expect(line.textContent, 'a disabled QUIC route is reported, not silently dropped').toContain(
      'HTTP/3 not available',
    );
  });

  it('⛔ says NOTHING when the harness never reported capabilities', async () => {
    // Absent must read as UNMEASURED, never as healthy. A row that silently
    // implies a clean egress from missing data is the failure this guards.
    sessionsList.mockResolvedValue({
      data: [
        session({
          id: 'ses_unreported',
          label: 'Unreported run',
          status: 'destroyed',
          destroyed_at: '2026-08-31T10:00:00.000Z',
          egress_capabilities: null,
        }),
      ],
    });
    render(<SessionsHistoryView />);
    await screen.findByText('Unreported run');
    expect(screen.queryByText(/^Egress:/)).toBeNull();
  });
});

// ⛔ GET /v1/sessions carries `egress_capabilities.warnings` as CODES, and this
// view printed them raw after the label "Proxy limits:". A /v1/sessions session
// linked to an agent session with no proxy of its own now carries
// `default_connection_down` (the connection Driftstack provides dropped), so the
// row read "Proxy limits: default_connection_down" — a raw code, filed under a
// proxy the customer does not have. It is also the view a stopped-session
// notification opens. Every code is now words, and only connection facts sit
// under the limits label.
describe('a history row says what each warning means, in words, under the right label', () => {
  // The published vocabulary, read from the api-types description the server's
  // parity guard holds equal to the mapping function's closed set — so a code the
  // server starts publishing reds HERE until this view has words for it.
  const PUBLISHED = [
    ...new Set(
      (EgressCapabilitiesSchema.shape.warnings.description ?? '').match(
        /(?<=`)[a-z0-9_:]+(?=`)/g,
      ) ?? [],
    ),
  ];
  const BANNED =
    /\b(fleet|nodes?|harness|control plane|observer|vantage|interpose|macworker|undetectable|egress)\b/i;

  async function rowText(warnings: string[], over: Record<string, unknown> = {}): Promise<string> {
    sessionsList.mockResolvedValue({
      data: [
        session({
          id: 'ses_warned',
          label: 'Warned run',
          status: 'destroyed',
          destroyed_at: '2026-08-31T10:00:00.000Z',
          egress_capabilities: EgressCapabilitiesSchema.parse({
            udp_associate: true,
            quic_route: 'proxy',
            dns_remote_resolve: true,
            warnings,
            ...over,
          }),
        }),
      ],
    });
    const { container } = render(<SessionsHistoryView />);
    await screen.findByText('Warned run');
    const li = container.querySelector('li');
    return li?.textContent ?? '';
  }

  it('positive control: the vocabulary is really read (every published code, both connection codes)', () => {
    expect(PUBLISHED.length).toBeGreaterThanOrEqual(12);
    expect(PUBLISHED).toContain('dead_proxy');
    expect(PUBLISHED).toContain('default_connection_down');
    expect(PUBLISHED).toContain('safeguard_failed:proxy_egress_verification');
  });

  it("CRITICAL default_connection_down reads as Driftstack's connection, on our side — no code, no proxy label", async () => {
    const text = await rowText(['default_connection_down']);
    expect(text).toContain("Driftstack's connection for this session dropped");
    expect(text).toContain('on our side');
    expect(text).not.toContain('default_connection_down');
    // The customer has no proxy on this session: nothing on the row may name one.
    expect(text).not.toMatch(/proxy/i);
  });

  it("dead_proxy is the customer's own proxy, said in words", async () => {
    const text = await rowText(['dead_proxy']);
    expect(text).toContain('Your proxy stopped answering');
    expect(text).not.toContain('dead_proxy');
  });

  it('the live-view codes say what happened to the live view, not to a proxy', async () => {
    const blank = await rowText(['streaming_blank']);
    expect(blank).toContain('The live view showed no picture');
    expect(blank).not.toMatch(/proxy/i);
    cleanup();
    const failed = await rowText(['streaming_failed']);
    expect(failed).toContain('The live view stopped');
    expect(failed).not.toMatch(/proxy/i);
  });

  it.each(PUBLISHED.map((code) => [code]))(
    'published code %s reads as words: never the token, never a banned word',
    async (code) => {
      const text = await rowText([code]);
      expect(text).not.toContain(code);
      // Every published code says SOMETHING — a reported problem must not vanish.
      expect(text).toMatch(/Connection limits: |live view|safeguard|check|proxy|connection/i);
      expect(text).not.toMatch(BANNED);
    },
  );

  it('an unknown code reads as a generic line, never the token', async () => {
    const text = await rowText(['zz_brand_new_code', 'constructor', '__proto__']);
    expect(text).toContain('Another issue was reported for this session');
    expect(text).not.toContain('zz_brand_new_code');
    expect(text).not.toContain('constructor');
    expect(text).not.toContain('__proto__');
    // Said once, however many unknown codes there were.
    expect(text.split('Another issue was reported for this session').length - 1).toBe(1);
    // A code that names a property every object has is still just an unknown code.
    for (const inherited of ['constructor', '__proto__', 'toString']) {
      cleanup();
      const alone = await rowText([inherited]);
      expect(alone, inherited).toContain('Another issue was reported for this session');
      expect(alone, inherited).not.toContain(inherited);
    }
  });

  it('a limit reported twice (the capability flag and its warning) is said once', async () => {
    const text = await rowText(['udp_unsupported_by_proxy', 'quic_unavailable'], {
      udp_associate: false,
      quic_route: 'disabled',
    });
    expect(text).toContain('Connection limits: UDP not supported · HTTP/3 not available');
    expect(text.split('UDP not supported').length - 1).toBe(1);
    expect(text.split('HTTP/3 not available').length - 1).toBe(1);
  });
});
