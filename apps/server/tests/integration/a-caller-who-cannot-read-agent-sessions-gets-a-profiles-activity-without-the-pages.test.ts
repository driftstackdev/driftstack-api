// Security sweep 2026-09-24, finding #3 — GET /v1/profiles/:id/activity handed
// agent-session navigation URLs to callers the agent-session surface refuses.
//
// The route projects every page an AI session planned to open — path and query
// included, so `https://bank.example/statements?acct=12345&token=secret` — plus
// the session ids, out of the account's agent-session transcripts. It was gated
// on `read:profiles` alone, so a read-only ('member') teammate acting in the
// owner's workspace, and a key holding only `read:profiles`, both read them,
// while the same callers get 403/404 from /v1/agent-sessions (team.md: "AI
// transcripts … require admin for both reads and writes"; the reads need
// `read:sessions`).
//
// Now the pages and session ids are gated exactly as agent-session reads are:
// `read:sessions` on the key and, in a teammate's workspace, the admin role. The
// rest of the feed stays readable — how many sessions were read and whether
// there is more — and the response says the pages were withheld rather than
// reading as "no activity".

import type { ApiKeyScope } from '@driftstack/api-types';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-0000000003a1';
const PROFILE_UUID = '33333333-3333-4333-8333-333333333301';
const PROFILE_ID = `prof_${PROFILE_UUID}`;
const MEMBERSHIP_ID = '00000000-0000-4000-8000-0000000003a2';
const SECRET_URL = 'https://bank.example/statements?acct=12345&token=secret';

interface Activity {
  data: Array<{ at: string; url: string; agent_session_id: string }>;
  sessions_scanned: number;
  truncated: boolean;
  pages_withheld?: boolean;
}

/** One agent session on `accountId`'s profile that opened SECRET_URL. */
async function seedActivity(accountId: string): Promise<string> {
  await fx.profilesRepo.insert({
    id: PROFILE_UUID,
    accountId,
    name: 'Banking',
    archetype: 'iphone-16-pro-ios-26-4-1',
    description: null,
  });
  const navigation: TranscriptEntry = {
    at: '2026-09-24T08:00:00.000Z',
    role: 'agent',
    body: '',
    intents: [{ kind: 'navigate', url: SECRET_URL }],
  };
  const session = await fx.agentSessionsRepo!.create({
    accountId,
    tokenBudgetTotal: 1000,
    profileId: PROFILE_UUID,
    seedTranscript: [navigation],
  });
  return session.id;
}

async function activity(headers: Record<string, string>): Promise<Activity> {
  const res = await fx.app.inject({
    method: 'GET',
    url: `/v1/profiles/${PROFILE_ID}/activity`,
    headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Activity>();
}

/** The caller (fx's key) as a teammate of OWNER with `role`. */
async function asTeammate(role: 'member' | 'admin', scopes?: ApiKeyScope[]): Promise<string> {
  fx = await buildTestApp({ enableAgentRuntime: true, ...(scopes ? { scopes } : {}) });
  await seedAdditionalAccount(fx, {
    accountId: OWNER_ACCOUNT_ID,
    apiKeyId: '00000000-0000-4000-8000-0000000003a3',
  });
  fx.authRepo.setTeamMemberships(fx.accountId, [
    { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ACCOUNT_ID, role },
  ]);
  return seedActivity(OWNER_ACCOUNT_ID);
}

const actAs = { 'x-driftstack-account': `acc_${OWNER_ACCOUNT_ID}` };

function expectWithheld(body: Activity, sessionId: string): void {
  const text = JSON.stringify(body);
  expect(text, 'a navigation URL reached a caller who cannot read agent sessions').not.toContain(
    'bank.example',
  );
  expect(text, 'an agent session id reached a caller who cannot read agent sessions').not.toContain(
    sessionId,
  );
  expect(body.data).toEqual([]);
  expect(body.pages_withheld).toBe(true);
  // The rest of the feed stays: how much activity there is.
  expect(body.sessions_scanned).toBe(1);
  expect(body.truncated).toBe(false);
}

describe("a caller who cannot read agent sessions gets a profile's activity without the pages", () => {
  it("CRITICAL a read-only ('member') teammate acting in the owner's workspace does not get the pages or session ids", async () => {
    const sessionId = await asTeammate('member');
    // The agent-session surface refuses this caller, which is the rule being matched.
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...actAs },
    });
    expect(list.statusCode).toBe(403);
    expectWithheld(await activity(actAs), sessionId);
  });

  it('CRITICAL a key holding read:profiles but not read:sessions does not get the pages on its own account', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read:profiles'] });
    const sessionId = await seedActivity(fx.accountId);
    expectWithheld(await activity({}), sessionId);
  });

  it("CRITICAL an admin teammate whose key lacks read:sessions does not get the owner's pages either — the key's scope still applies in a teammate's workspace", async () => {
    const sessionId = await asTeammate('admin', ['read:profiles']);
    expectWithheld(await activity(actAs), sessionId);
  });

  it("control: an admin teammate with read access gets the owner's pages, as /v1/agent-sessions would give them the transcripts", async () => {
    const sessionId = await asTeammate('admin');
    const body = await activity(actAs);
    expect(body.data).toEqual([
      { at: '2026-09-24T08:00:00.000Z', url: SECRET_URL, agent_session_id: sessionId },
    ]);
    expect(body.pages_withheld).toBe(false);
  });

  it('control: the owner, and a key holding read:profiles AND read:sessions, get the pages', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const sessionId = await seedActivity(fx.accountId);
    const own = await activity({});
    expect(own.data.map((e) => [e.url, e.agent_session_id])).toEqual([[SECRET_URL, sessionId]]);
    await fx.cleanup();

    fx = await buildTestApp({
      enableAgentRuntime: true,
      scopes: ['read:profiles', 'read:sessions'],
    });
    const second = await seedActivity(fx.accountId);
    const narrow = await activity({});
    expect(narrow.data.map((e) => [e.url, e.agent_session_id])).toEqual([[SECRET_URL, second]]);
    expect(narrow.pages_withheld).toBe(false);
  });
});
