import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWS = resolve(HERE, '..', '..', 'src', 'views');
/**
 * The AI view is no longer ONE file. Stage 0 of the 2026-09-19 rebuild split
 * `AgentChatView.tsx` into `views/agent-chat/*`, and the SDK calls went with the
 * pieces that make them — the live-view token fetch now lives in
 * `agent-chat/LiveAutomationPanel.tsx`. Listing only the view would have left
 * every one of those files scanned by nothing, which is indistinguishable from
 * passing. So the folder is DERIVED, not typed out: a file added by stage 2 or
 * stage 4 is covered by the next run, and an empty derivation is refused below.
 */
const AGENT_CHAT = resolve(VIEWS, 'agent-chat');
const AGENT_CHAT_FILES = readdirSync(AGENT_CHAT)
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  .map((f) => `agent-chat/${f}`);
const SDK_BACKED_VIEWS = [
  'TeamView.tsx',
  'AgentChatView.tsx',
  'SessionsHistoryView.tsx',
  'ProfilesView.tsx',
  'RecipesView.tsx',
  'ConnectivityView.tsx',
  'FirstRunWizard.tsx',
  'SessionsView.tsx',
  ...AGENT_CHAT_FILES,
] as const;

describe('SDK problem copy boundary', () => {
  it('CRITICAL the sweep still reaches the AI view after it was split into a folder. A derived list that derives nothing scans nothing and reports clean.', () => {
    expect(
      AGENT_CHAT_FILES.length,
      'no agent-chat source files were found to scan',
    ).toBeGreaterThan(5);
  });

  it.each(SDK_BACKED_VIEWS)('%s never reflects remote problem prose', (view) => {
    const body = readFileSync(resolve(VIEWS, view), 'utf8');

    expect(body).not.toMatch(/err\.(?:title|detail)/);
    expect(body).not.toMatch(/DriftstackError[\s\S]{0,160}\?\s*err\.message/);
    expect(body).not.toMatch(
      /if \(err instanceof DriftstackError\)[\s\S]{0,120}return err\.message/,
    );
  });
});
