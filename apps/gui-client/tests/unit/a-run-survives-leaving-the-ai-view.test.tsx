// B5 — switching away from the AI view used to KILL the running task.
//
// `App.tsx` renders `AgentChatView` only for the `ai` destination, so navigating
// to Profiles (or Settings, which is where the chat's own "Use my own key"
// button goes) unmounted the view. That ran `useAgentChat`'s teardown, which
// bumps the cancel generation and closes the server session — ending a task the
// customer was watching, mid-run, with nothing on screen to say so.
//
// The chat now lives in a provider ABOVE the view switch. The view still mounts
// and unmounts normally; the run does not. Both halves are asserted, because
// only the pair is the fix:
//
//   • unmounting the consumer must NOT close the session and must NOT discard
//     the turn's result;
//   • unmounting the PROVIDER (sign-out, app quit) must still close it, or the
//     leak the teardown existed to prevent comes straight back.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();

// ⛔ ONE client object, module-scoped. `useSettings` memoises the SDK client on
// [apiKey, baseUrl, workspace], and the chat now treats a CHANGE of that object
// as the auth boundary — it is what tells sign-out (and a re-sign-in under a
// different key) apart from an ordinary re-render. A mock that built a fresh
// literal per call reported a sign-out on every render.
const CLIENT = { agentSessions: { create, message, close } };
/** Nulled by the sign-out gesture below, exactly as `buildClient` nulls it when
 *  the API key is cleared. */
let currentClient: typeof CLIENT | null = CLIENT;

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: currentClient }),
}));
const clearProfileSession = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: () => Promise.resolve(),
  clearSession: clearProfileSession,
}));

const { AgentChatProvider, useAgentChatSession } = await import('../../src/lib/AgentChatProvider');

const SESSION: AgentSession = {
  id: 'agt_1',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  stop_on_exit_ip_change: false,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 2,
  closed_at: null,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-opus-4-7',
  pair_mode_state: null,
  created_at: '2026-06-14T00:00:00Z',
  updated_at: '2026-06-14T00:00:01Z',
};

const NAV = { kind: 'navigate', url: 'https://example.com' } as const;
const DONE: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [NAV],
  results: [{ kind: 'success', intent: NAV, summary: 'ok' }],
  ok: true,
};

/** Stands in for AgentChatView: reads the app-wide chat, seeds its picks the way
 *  the real view does, and renders the turn count. `boundProfile` mirrors the
 *  profile picker — which lives in the view, but whose VALUE lives above it. */
function ChatConsumer({ boundProfile }: { boundProfile?: string }): JSX.Element {
  const { chat, setChatOptions, setProfileId } = useAgentChatSession();
  useEffect(() => {
    setChatOptions({});
    if (boundProfile !== undefined) setProfileId(boundProfile);
  }, [setChatOptions, setProfileId, boundProfile]);
  return (
    <div>
      <span data-testid="turns">{chat.turns.length}</span>
      <span data-testid="sending">{String(chat.sending)}</span>
      <button type="button" onClick={() => void chat.send('go to example.com')}>
        Send
      </button>
      <button type="button" onClick={() => chat.reset()}>
        New chat
      </button>
    </div>
  );
}

/**
 * The app shape that matters, reproduced rather than approximated.
 *
 * ⛔ Sign-out does NOT unmount anything here, and that is the point. The real
 * `handleSignOut` only nulls the API key; the shell then takes an early return
 * to the first-run wizard from INSIDE itself, while every provider above it —
 * `AgentChatProvider` included — stays mounted. A test that called
 * `view.unmount()` to stand in for signing out was asserting a gesture the app
 * never performs, so it reported coverage for a leak that was wide open.
 */
function Shell({
  children,
  boundProfile,
}: {
  children?: ReactNode;
  boundProfile?: string;
}): JSX.Element {
  const [view, setView] = useState<'ai' | 'profiles'>('ai');
  const [signedIn, setSignedIn] = useState(true);
  return (
    <AgentChatProvider>
      <button type="button" onClick={() => setView('profiles')}>
        Go to profiles
      </button>
      <button type="button" onClick={() => setView('ai')}>
        Back to AI
      </button>
      <button
        type="button"
        onClick={() => {
          currentClient = null; // buildClient(null, …) → null
          setSignedIn(false);
        }}
      >
        Sign out
      </button>
      <button
        type="button"
        onClick={() => {
          currentClient = CLIENT;
          setSignedIn(true);
        }}
      >
        Sign in
      </button>
      {!signedIn ? (
        // The first-run wizard: an early return from within the shell, BELOW the
        // provider. Nothing above it unmounts.
        <div data-testid="wizard">Welcome</div>
      ) : view === 'ai' ? (
        <ChatConsumer boundProfile={boundProfile} />
      ) : (
        <div data-testid="other-view">Profiles</div>
      )}
      {children}
    </AgentChatProvider>
  );
}

describe('a run survives leaving the AI view', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    close.mockReset();
    create.mockResolvedValue(SESSION);
    clearProfileSession.mockClear();
    currentClient = CLIENT;
  });

  it('keeps the session open and lands the result after switching away and back', async () => {
    let settle!: (r: AgentMessageResponse) => void;
    message.mockImplementationOnce(
      () =>
        new Promise<AgentMessageResponse>((resolve) => {
          settle = resolve;
        }),
    );

    render(<Shell />);
    await act(async () => {
      screen.getByRole('button', { name: 'Send' }).click();
      await Promise.resolve();
    });
    expect(message).toHaveBeenCalledTimes(1);

    // Leave the AI view WHILE the turn is running — the exact gesture that used
    // to end it.
    await act(async () => {
      screen.getByRole('button', { name: 'Go to profiles' }).click();
      await Promise.resolve();
    });
    expect(screen.getByTestId('other-view')).toBeTruthy();
    expect(close, 'leaving the view must not close a running session').not.toHaveBeenCalled();

    // The server finishes while the customer is elsewhere.
    await act(async () => {
      settle(DONE);
      await Promise.resolve();
    });

    await act(async () => {
      screen.getByRole('button', { name: 'Back to AI' }).click();
      await Promise.resolve();
    });
    // The user bubble AND the agent reply are both there: the result was not
    // discarded by a bumped cancel generation.
    expect(screen.getByTestId('turns').textContent).toBe('2');
    expect(screen.getByTestId('sending').textContent).toBe('false');
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the session and drops the transcript when the customer SIGNS OUT', async () => {
    // The negative control, driven by the real gesture. Without it, "never
    // closes" would pass the arm above just as well as "closes at the right
    // time" — and this is also the arm that keeps one account's conversation out
    // of the next account's screen on a shared machine.
    message.mockResolvedValue(DONE);
    render(<Shell />);
    await act(async () => {
      screen.getByRole('button', { name: 'Send' }).click();
      await Promise.resolve();
    });
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByTestId('turns').textContent).toBe('2');

    await act(async () => {
      screen.getByRole('button', { name: 'Sign out' }).click();
      await Promise.resolve();
    });
    // The wizard is up, the provider never unmounted, and the session is closed
    // anyway — through the client that still holds the credential the DELETE
    // needs, which the incoming (null) one does not.
    expect(screen.getByTestId('wizard')).toBeTruthy();
    expect(close).toHaveBeenCalledWith(SESSION.id);

    // Sign back in: the previous account's turns must not be sitting there.
    await act(async () => {
      screen.getByRole('button', { name: 'Sign in' }).click();
      await Promise.resolve();
    });
    expect(screen.getByTestId('turns').textContent).toBe('0');
  });

  it('still clears the RIGHT profile binding after a trip out of the view', async () => {
    // ⛔ The second casualty of view-local picks, and the quieter one. On remount
    // the view re-published its options with `profileId` reset to '' — which the
    // options record omits entirely — so the hook's `profileIdRef` became
    // undefined and `clearProfileBinding` no-opped from then on. The Profiles hub
    // was left showing a profile as running on an AI session that had ended, which
    // is the exact stuck state that binding cleanup exists to prevent.
    message.mockResolvedValue(DONE);
    render(<Shell boundProfile="prof_bound" />);
    await act(async () => {
      screen.getByRole('button', { name: 'Send' }).click();
      await Promise.resolve();
    });

    await act(async () => {
      screen.getByRole('button', { name: 'Go to profiles' }).click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Back to AI' }).click();
      await Promise.resolve();
    });

    await act(async () => {
      screen.getByRole('button', { name: 'New chat' }).click();
      await Promise.resolve();
    });
    expect(clearProfileSession).toHaveBeenCalledWith('prof_bound');
  });

  it('still closes the session when the app itself goes away (quit)', async () => {
    message.mockResolvedValue(DONE);
    const view = render(<Shell />);
    await act(async () => {
      screen.getByRole('button', { name: 'Send' }).click();
      await Promise.resolve();
    });
    expect(close).not.toHaveBeenCalled();

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
    expect(close).toHaveBeenCalledWith(SESSION.id);
  });

  it('refuses to run without a provider rather than silently reviving the bug', () => {
    // A context fallback that quietly created a per-view hook would look
    // identical on screen and restore the exact defect this file covers.
    // The throw is the assertion, so its console noise is expected output, not a
    // second failure: swallow React's log AND jsdom's uncaught-error report.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const swallow = (event: Event): void => {
      event.preventDefault();
    };
    window.addEventListener('error', swallow);
    try {
      expect(() => render(<ChatConsumer />)).toThrow(/AgentChatProvider/);
    } finally {
      window.removeEventListener('error', swallow);
      spy.mockRestore();
    }
  });
});
