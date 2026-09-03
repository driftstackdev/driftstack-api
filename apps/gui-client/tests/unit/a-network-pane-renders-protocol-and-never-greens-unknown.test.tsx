// OWNER ITEM T-9 (GUI half) — a devtools-style Network panel in the simulator,
// showing per-request protocol (HTTP/2 vs HTTP/3). The rule the whole pane rests
// on (N-2): the protocol is a CLOSED set { h1, h2, h3 }; the GREEN badge is
// reserved for h3 alone, and anything outside the set renders NEUTRAL — never a
// green HTTP/3 badge for a value we cannot vouch for.
//
// MEASURED mechanism: components/NetworkListSubscriber renders one row per request
// and, for each, a protocol badge whose tone is derived SOLELY from
// cleanMeasuredProtocol's verdict. The h3 tone is the only one carrying the green
// (emerald) color class; h1/h2/unknown carry non-green classes. The pane also
// shows an honest "No requests captured yet" empty state, because A3 has not wired
// the harness emission yet so the feed is legitimately empty in production today.
//
// Renders the real component (no full SimulatorWindow, so none of the ~17
// simulator-window mocks are involved). .test.tsx → jsdom.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { createNetworkLogStore, type NetworkRequestEntry } from '../../src/lib/network-log-feed';
import { NetworkListSubscriber } from '../../src/components/NetworkListSubscriber';

function makeEntry(id: string, protocol: string): NetworkRequestEntry {
  return {
    id,
    url: `https://example.com/${id}.js`,
    method: 'GET',
    status: 200,
    protocol,
    started_at: 0,
  };
}

/** Every rendered protocol badge with its tone + whether it is styled green. The
 *  green test keys on the emerald color token, which only the h3 tone carries. */
function badges(container: HTMLElement): { tone: string; green: boolean; label: string }[] {
  return Array.from(container.querySelectorAll('[data-component="net-proto-badge"]')).map((el) => ({
    tone: el.getAttribute('data-protocol-tone') ?? '',
    green: el.className.includes('emerald'),
    label: el.textContent ?? '',
  }));
}

function renderPane(entries: NetworkRequestEntry[]) {
  const store = createNetworkLogStore();
  store.append(entries, null); // flip null → a real array before mount
  return render(
    <NetworkListSubscriber store={store} sessionId="agt_x" note={null} refreshing={false} />,
  );
}

describe('Network pane — protocol badges never green an unknown value', () => {
  it('renders one row per request with distinct protocol labels', () => {
    const { container } = renderPane([
      makeEntry('a', 'h1'),
      makeEntry('b', 'h2'),
      makeEntry('c', 'h3'),
    ]);
    const rows = container.querySelectorAll('[data-component="simulator-network-row"]');
    expect(rows.length).toBe(3);
    const labels = badges(container).map((b) => b.label);
    expect(labels).toEqual(['HTTP/1.1', 'HTTP/2', 'HTTP/3']);
  });

  // VACUITY CONTROL / positive arm — proves the "green" detector can actually
  // fire. Without this, "unknown is not green" could pass simply because NOTHING
  // is ever green (a broken selector, or an h3 that lost its color). The h3 badge
  // MUST be green, so every "not green" assertion below has real teeth.
  it('vacuity control — the h3 badge IS green', () => {
    const { container } = renderPane([makeEntry('c', 'h3')]);
    const h3 = badges(container).find((b) => b.tone === 'h3');
    expect(h3).toBeDefined();
    expect(h3?.green).toBe(true);
  });

  it('the h2 badge is NOT green (neutral-strong)', () => {
    const { container } = renderPane([makeEntry('b', 'h2')]);
    const h2 = badges(container).find((b) => b.tone === 'h2');
    expect(h2?.green).toBe(false);
  });

  it('the h1 badge is NOT green (muted)', () => {
    const { container } = renderPane([makeEntry('a', 'h1')]);
    const h1 = badges(container).find((b) => b.tone === 'h1');
    expect(h1?.green).toBe(false);
  });

  // The core guard. Mutation (a) — "render an unknown protocol as the h3 green
  // badge" — makes this unknown row carry the green class; this fails then.
  it('an unknown protocol renders NEUTRAL, never a green h3 badge', () => {
    const { container } = renderPane([makeEntry('u', 'h9')]);
    const list = badges(container);
    expect(list.length).toBe(1);
    const unknown = list[0];
    expect(unknown?.tone).toBe('neutral');
    expect(unknown?.green).toBe(false);
    // It is shown neutral, not silently dropped — the raw token stays visible.
    expect(unknown?.label).toBe('h9');
  });

  it('across a mixed table, EXACTLY ONE badge is green and it is the h3 one', () => {
    const { container } = renderPane([
      makeEntry('a', 'h1'),
      makeEntry('b', 'h2'),
      makeEntry('c', 'h3'),
      makeEntry('u', 'quic-draft'),
    ]);
    const green = badges(container).filter((b) => b.green);
    expect(green.length).toBe(1);
    expect(green[0]?.tone).toBe('h3');
  });

  it('an empty feed shows the honest "No requests captured yet" state', () => {
    const store = createNetworkLogStore();
    store.append([], null); // an empty ok poll → [] snapshot, not null
    const { container, queryByText } = render(
      <NetworkListSubscriber store={store} sessionId="agt_x" note={null} refreshing={false} />,
    );
    expect(queryByText('No requests captured yet')).not.toBeNull();
    // And no rows / no green badge in the empty state.
    expect(container.querySelectorAll('[data-component="simulator-network-row"]').length).toBe(0);
    expect(badges(container).length).toBe(0);
  });
});
