// P2 #6 — AgentChatView must sync its profile selection when a re-deep-link changes
// `initialProfileId`. profileId is seeded from initialProfileId via useState (mount-
// only), so opening the agent chat again for a DIFFERENT profile (the deep-link
// arrives while the component is still mounted) used to leave the previous profile
// selected. A change-only sync effect now updates it.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';

const client = {
  recipes: { create: vi.fn() },
  // Two profiles so the picker has selectable options.
  profiles: {
    iterate: function* () {
      yield { id: 'prof_a', name: 'Profile A' };
      yield { id: 'prof_b', name: 'Profile B' };
    },
  },
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client, settings: { apiKey: 'sk-test' } }),
}));
vi.mock('../../src/lib/toasts', () => ({ useToasts: () => ({ push: vi.fn() }) }));

const chatState: UseAgentChatResult = {
  turns: [],
  session: null,
  sending: false,
  error: null,
  pendingConfirmation: null,
  deniedTurnIds: new Set<number>(),
  send: vi.fn(() => Promise.resolve(true)),
  approve: vi.fn(() => Promise.resolve()),
  deny: vi.fn(),
  reset: vi.fn(),
  restore: vi.fn(),
} as unknown as UseAgentChatResult;

vi.mock('../../src/lib/use-agent-chat', () => ({ useAgentChat: () => chatState }));

// Chat-history persistence — stub so no Tauri store runtime is needed (mirrors the
// real chat-history surface AgentChatView imports). Only the empty no-op path runs
// here (no turns are sent).
vi.mock('../../src/lib/chat-history', () => ({
  loadChats: () => Promise.resolve([]),
  upsertChat: () => Promise.resolve([]),
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
}));

const { AgentChatView } = await import('../../src/views/AgentChatView');

function profileSelect(c: HTMLElement): HTMLSelectElement {
  return c.querySelector('select[aria-label="Profile"]') as HTMLSelectElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentChatView — initialProfileId re-deep-link sync (P2 #6)', () => {
  it('updates the selected profile when initialProfileId changes on a re-render', async () => {
    const { container, rerender } = render(<AgentChatView initialProfileId="prof_a" />);
    // The picker is seeded with the initial profile.
    await waitFor(() => expect(profileSelect(container).value).toBe('prof_a'));
    // A NEW deep-link arrives for a different profile while still mounted.
    rerender(<AgentChatView initialProfileId="prof_b" />);
    await waitFor(() => expect(profileSelect(container).value).toBe('prof_b'));
  });

  it('does NOT clobber the selection when initialProfileId is unchanged/absent on re-render', async () => {
    const { container, rerender } = render(<AgentChatView initialProfileId="prof_a" />);
    await waitFor(() => expect(profileSelect(container).value).toBe('prof_a'));
    // The user manually picks a different profile in-session.
    const select = profileSelect(container);
    select.value = 'prof_b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(profileSelect(container).value).toBe('prof_b'));
    // A re-render with NO initialProfileId (no new deep-link) must NOT reset it.
    rerender(<AgentChatView />);
    expect(profileSelect(container).value).toBe('prof_b');
  });
});
