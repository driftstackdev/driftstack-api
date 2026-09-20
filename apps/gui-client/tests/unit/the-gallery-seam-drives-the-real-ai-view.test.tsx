// The gallery seam (spec §8) — how the AI view's seven state scenes reach
// states that need a live device, WITHOUT becoming a replica of the view.
//
// The whole value of an audit scene is that the gates measure the SHIPPED
// component. A scene that redrew the running state as its own markup would
// pass every gate on a copy of the view and say nothing about the view. So the
// seam is three narrow doors, and this file guards each one's two halves — it
// opens, and it is SHUT in the app:
//
//   1. `AgentChatProvider value={…}`: fixture context fields, merged over the
//      real ones, DEFINED KEYS ONLY. A plain `Partial` spread copies explicit
//      `undefined`s over live values, and a context whose `chat` went missing
//      throws one render later, a long way from the cause.
//   2. `standIn`: an image in the live view's screen INSTEAD of a stream token.
//      "Instead" is the load-bearing word — a scene that showed a picture and
//      still opened a LiveKit room would be measuring a different component's
//      work, and in the harness there is nothing to connect to anyway.
//   3. `CaptureThumbnail src`: an image instead of an authed capture fetch.
//
// …and one property the scenes themselves must have: the drawn pages are
// IMAGES. Text inside them would be measured by scripts/gui-text-quality.mjs as
// the app's own copy — its 9px floor, its contrast rule, its truncation rule —
// and a picture of a shop page legitimately has 9px grey type on it.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentChatProvider, useAgentChatSession } from '../../src/lib/AgentChatProvider';
import type * as UseAgentChatModule from '../../src/lib/use-agent-chat';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';
import { CaptureThumbnail } from '../../src/components/CaptureThumbnail';
import { LiveAutomationPanel } from '../../src/views/agent-chat/LiveAutomationPanel';
import { SettingsContext } from '../../src/lib/SettingsContext';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';
import type { DriftstackClient } from '../../src/lib/client';
import { fetchAgentCapture } from '../../src/lib/agent-session-control';
import {
  AGENT_CHAT_SCENE_KINDS,
  agentChatSceneFixture,
} from '../../src/visual-harness/agent-chat-scenes';
import { AUDIT_SCENES, sceneSize } from '../../src/visual-harness/gallery';
import { agentChatFixtureFor, auditLoadedMarkers } from '../../src/visual-harness/audit-scenes';

vi.mock('../../src/lib/agent-session-control', () => ({
  fetchAgentCapture: vi.fn(() => Promise.resolve(null)),
}));
// The provider mounts the real hook; the view is not rendered here, so the hook
// only needs to not reach the network. It reads the client off SettingsContext,
// which is `null` below in every arm that mounts the provider.
vi.mock('../../src/lib/use-agent-chat', async (importOriginal) => {
  const real = await importOriginal<typeof UseAgentChatModule>();
  return { ...real, useAgentChat: (): UseAgentChatResult => emptyChat() };
});

const FROZEN = Date.parse('2026-06-15T06:42:00.000Z');

/** The fixture for a scene, refusing the two that carry none. One place where
 *  `chat` is unwrapped, so no arm quietly measures `undefined`. */
function fixtureChat(kind: (typeof AGENT_CHAT_SCENE_KINDS)[number]): UseAgentChatResult {
  const chat = agentChatSceneFixture(kind, FROZEN).chat;
  if (chat === undefined) throw new Error(`the ${kind} scene carries no chat fixture`);
  return chat;
}

/** What the provider publishes when NOTHING overrides it — the hook's real
 *  shape (borrowed from a fixture, so this file holds no second copy of the
 *  hook's contract) emptied of everything the probe reads. The two must be
 *  tellable apart, or an override that was silently ignored would look exactly
 *  like one that worked. */
function emptyChat(): UseAgentChatResult {
  return { ...fixtureChat('running'), turns: [], sending: false, livePhase: null };
}

function settingsValue(
  client: DriftstackClient | null,
): React.ComponentProps<typeof SettingsContext.Provider>['value'] {
  return {
    settings: { ...DEFAULT_SETTINGS, apiKey: 'ds_live_example' },
    loading: false,
    client,
    activeWorkspace: null,
    setActiveWorkspace: () => undefined,
    accountMe: null,
    refreshAccountMe: () => Promise.resolve(),
    authExpired: false,
    dismissAuthExpired: () => undefined,
    update: () => Promise.resolve(),
  };
}

/** Reads the context the way the real view does and prints the two fields a
 *  scene overrides, so an arm below can see what the provider published. */
function Probe(): JSX.Element {
  const { chat, chatId, captureSrc } = useAgentChatSession();
  return (
    <div>
      <span data-testid="turns">{String(chat.turns.length)}</span>
      <span data-testid="phase">{chat.livePhase ?? '(none)'}</span>
      <span data-testid="chat-id">{chatId.length > 0 ? 'real' : 'empty'}</span>
      <span data-testid="capture-src">{captureSrc ?? '(none)'}</span>
    </div>
  );
}

function renderProbe(value?: Parameters<typeof AgentChatProvider>[0]['value']): void {
  render(
    <SettingsContext.Provider value={settingsValue(null)}>
      <AgentChatProvider value={value}>
        <Probe />
      </AgentChatProvider>
    </SettingsContext.Provider>,
  );
}

describe('door 1 — a fixture chat drives the view through the REAL provider', () => {
  it('publishes the override, and keeps the provider’s own fields beside it', () => {
    renderProbe({ chat: fixtureChat('running'), captureSrc: 'data:image/svg+xml,<svg/>' });
    expect(screen.getByTestId('turns')).toHaveTextContent('1');
    expect(screen.getByTestId('phase')).toHaveTextContent('Looking at the page…');
    expect(screen.getByTestId('capture-src')).toHaveTextContent('data:image/svg+xml,<svg/>');
    // The provider still owns the chat's identity — a scene overrides what it
    // names and nothing else, so the view's effects run as they do in the app.
    expect(screen.getByTestId('chat-id')).toHaveTextContent('real');
  });

  it('is SHUT in the app: with no override the provider publishes its own hook', () => {
    // Vacuity control for the arm above. Without this, an override that was
    // silently ignored would look identical to one that worked, because the
    // fixture and the hook would both be "some chat".
    renderProbe();
    expect(screen.getByTestId('turns')).toHaveTextContent('0');
    expect(screen.getByTestId('phase')).toHaveTextContent('(none)');
    expect(screen.getByTestId('capture-src')).toHaveTextContent('(none)');
  });

  it('an explicit undefined in the override does NOT erase the field it names', () => {
    // `{...base, ...{chat: undefined}}` publishes a context with no chat, and
    // every read in the view throws one render later — far from the cause.
    renderProbe({ chat: undefined, standIn: undefined, captureSrc: undefined });
    expect(screen.getByTestId('turns')).toHaveTextContent('0');
    expect(screen.getByTestId('capture-src')).toHaveTextContent('(none)');
  });
});

describe('door 2 — a stand-in replaces the stream, it does not sit beside it', () => {
  function panelClient(): { client: DriftstackClient; livekitToken: ReturnType<typeof vi.fn> } {
    const livekitToken = vi.fn(() => new Promise<never>(() => undefined));
    return {
      client: { agentSessions: { livekitToken } } as unknown as DriftstackClient,
      livekitToken,
    };
  }

  it('with a stand-in: the screen holds the image and NO token is fetched', () => {
    const { client, livekitToken } = panelClient();
    render(
      <SettingsContext.Provider value={settingsValue(client)}>
        <LiveAutomationPanel
          sessionId="agt_audit_running"
          visible
          standIn={<img src="data:image/svg+xml,<svg/>" alt="" data-testid="stand-in" />}
        />
      </SettingsContext.Provider>,
    );
    expect(screen.getByTestId('stand-in')).toBeInTheDocument();
    expect(livekitToken).not.toHaveBeenCalled();
    // …and the placeholder the pane shows with no session is not ALSO rendered.
    expect(screen.queryByText('Nothing running yet')).not.toBeInTheDocument();
  });

  it('is SHUT in the app: with no stand-in the same session fetches its token', () => {
    const { client, livekitToken } = panelClient();
    render(
      <SettingsContext.Provider value={settingsValue(client)}>
        <LiveAutomationPanel sessionId="agt_audit_running" visible />
      </SettingsContext.Provider>,
    );
    expect(livekitToken).toHaveBeenCalledWith('agt_audit_running');
  });
});

describe('door 3 — a supplied image replaces the authed capture fetch', () => {
  it('renders the image with the shipped alt text and fetches nothing', async () => {
    render(
      <CaptureThumbnail
        baseUrl="https://api.example.com"
        apiKey="ds_live_example"
        sessionId="agt_audit_done"
        captureId="cap_audit_product_page"
        src="data:image/svg+xml,<svg/>"
      />,
    );
    const img = await screen.findByAltText('Screenshot the agent captured on this step');
    expect(img).toHaveAttribute('src', 'data:image/svg+xml,<svg/>');
    expect(vi.mocked(fetchAgentCapture)).not.toHaveBeenCalled();
  });

  it('is SHUT in the app: with no src the same props go to the capture route', async () => {
    render(
      <CaptureThumbnail
        baseUrl="https://api.example.com"
        apiKey="ds_live_example"
        sessionId="agt_audit_done"
        captureId="cap_audit_product_page"
      />,
    );
    await waitFor(() => {
      expect(vi.mocked(fetchAgentCapture)).toHaveBeenCalledWith(
        'https://api.example.com',
        'ds_live_example',
        'agt_audit_done',
        'cap_audit_product_page',
      );
    });
  });
});

describe('the drawn pages are images, never markup with text in them', () => {
  it('every stand-in a scene supplies renders as one <img> with no text node under it', () => {
    // ⛔ `ended` IS DELIBERATELY NOT IN HERE, and the exemption is narrow enough
    // to be worth stating (stage 7). Every other scene's stand-in is a DRAWING
    // of a web page, and a drawing must be an image: as DOM its 9px grey type
    // would be measured as the app's own copy by the text gate. `ended` mounts
    // the REAL `AgentSessionPanel`, whose overlay IS the app's copy and is
    // exactly what that gate should measure. The arm below holds the exemption
    // shut: that scene renders the real panel and no <img> at all, so it cannot
    // become a hiding place for drawn markup.
    const drawn = AGENT_CHAT_SCENE_KINDS.filter((k) => k !== 'ended');
    const withStandIn = drawn
      .map((kind) => agentChatSceneFixture(kind, FROZEN))
      .filter((f) => f.standIn !== undefined);
    // Derived, and refused when it derives nothing: a rename that stopped every
    // scene supplying a stand-in would otherwise pass this as a clean run.
    expect(withStandIn.length, 'no scene supplies a stand-in to check').toBeGreaterThanOrEqual(4);
    for (const fixture of withStandIn) {
      const { container, unmount } = render(<div>{fixture.standIn}</div>);
      const imgs = container.querySelectorAll('img');
      expect(imgs).toHaveLength(1);
      expect(imgs[0]?.getAttribute('src') ?? '').toMatch(/^data:image\/svg\+xml,/);
      expect((container.textContent ?? '').trim()).toBe('');
      unmount();
    }
  });

  it('the ONE scene that is not a drawing mounts the real live panel, and draws nothing of its own', () => {
    // Stage 7. The panel's own overlays — the terminal recap, the give-up
    // verdict, the slow-start notice — are the one thing an image cannot stand
    // in for, and no gate had ever rendered them: they need a token, a room and
    // a session that ends. This scene hands the real component the `sessionEnded`
    // value `LiveAutomationPanel` latches from the session poll, which is the
    // same value by the same route, minus a server.
    const ended = agentChatSceneFixture('ended', FROZEN);
    expect(ended.standIn).toBeDefined();
    const { container, unmount } = render(<div>{ended.standIn}</div>);
    expect(container.querySelector('[data-component="agent-session-panel"]')).not.toBeNull();
    // The REAL overlay, with the REAL mapped copy — not a fixture sentence.
    // `renderer_crashed` is a close reason, and the panel is what turns it into
    // words; a scene that wrote the words itself would measure nothing.
    expect(container.textContent ?? '').toContain('Session ended');
    expect(container.textContent ?? '').toContain('The page stopped unexpectedly');
    // …and no drawn page smuggled in beside it.
    expect(container.querySelectorAll('img')).toHaveLength(0);
    unmount();
  });

  it('and so does the captured screenshot the done scene shows', () => {
    const done = agentChatSceneFixture('done', FROZEN);
    expect(done.captureSrc ?? '').toMatch(/^data:image\/svg\+xml,/);
    // The drawing itself carries the shop host, not a real one.
    expect(decodeURIComponent(done.captureSrc ?? '')).toContain('shop.example.com');
  });
});

describe('every AI-view state is registered everywhere a scene has to be', () => {
  const sceneNames = AGENT_CHAT_SCENE_KINDS.map((k) => `audit-agent-chat-${k}`);

  it('the nine kinds and the nine scene names are the same nine', () => {
    // Seven STATES plus two WINDOWS. `small` is the running state at the
    // 960x600 Tauri minimum; `ended` is the live panel's own terminal overlay
    // at the same size (stage 7) — the box where its copy actually has to fit.
    // Both exist so the narrow tier is measured by the text gate rather than
    // hand-checked once (stage 6's and stage 4's open issues); the gate renders
    // each scene at its own declared size and never passes `?stage=`, so a
    // scene is the only way in.
    expect(sceneNames.length).toBe(9);
    for (const name of sceneNames) {
      expect(AUDIT_SCENES as ReadonlyArray<string>, name).toContain(name);
    }
    // …and no AI-view state scene exists that has no fixture behind it.
    const registered = (AUDIT_SCENES as ReadonlyArray<string>).filter(
      (n) => n.startsWith('audit-agent-chat-') && n !== 'audit-agent-chat',
    );
    expect(registered.sort()).toEqual([...sceneNames].sort());
  });

  it('each one has a stage, a fixture and loaded markers that begin with its OWN strings', () => {
    for (const name of sceneNames) {
      const size = sceneSize(name as (typeof AUDIT_SCENES)[number]);
      expect(size.width, name).toBeGreaterThan(0);
      expect(size.height, name).toBeGreaterThan(0);
      const fixture = agentChatFixtureFor(name as (typeof AUDIT_SCENES)[number]);
      expect(fixture.markers.length, name).toBeGreaterThan(0);
      const markers = auditLoadedMarkers(name as (typeof AUDIT_SCENES)[number]);
      // The scene's own strings come first and the two async loads come last:
      // the privacy scan snapshots the DOM the moment the LAST marker appears,
      // so a list ending on a synchronous string scans a half-loaded window.
      expect(markers.slice(0, fixture.markers.length)).toEqual([...fixture.markers]);
      expect(markers.length).toBeGreaterThan(fixture.markers.length);
    }
  });

  it('a name that is not one of them THROWS rather than falling back to the idle scene', () => {
    // A silent fallback would render `audit-agent-chat` under another name, and
    // the gate would report a state it had never measured.
    expect(() => agentChatFixtureFor('audit-agent-chat')).toThrow(/state scenes/);
    expect(() => agentChatFixtureFor('audit-proxies')).toThrow(/state scenes/);
  });

  it('only the no-key scene withholds the API key, and only it omits a chat override', () => {
    // The no-key state is reachable from settings alone, and it has to STAY
    // that way: it is the state `getByRole('status')` is pinned against with no
    // name, and a fixture chat could quietly add a second live region.
    for (const kind of AGENT_CHAT_SCENE_KINDS) {
      const fixture = agentChatSceneFixture(kind, FROZEN);
      if (kind === 'nokey') {
        expect(fixture.apiKey).toBeNull();
        expect(fixture.chat).toBeUndefined();
      } else {
        expect(fixture.apiKey, kind).not.toBeNull();
        expect(fixture.chat, kind).toBeDefined();
      }
    }
  });
});
