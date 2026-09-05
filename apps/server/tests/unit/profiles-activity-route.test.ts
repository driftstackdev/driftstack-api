// P-23 — GET /v1/profiles/:id/activity: a profile's recent navigation projected
// from its agent session transcripts.
//
// The property this route exists to hold, and the one the name encodes: this is
// ACCOUNT ACTIVITY, not "browsing history". Ledger decision D-1 keeps the
// server-side transcript out of the profile's Clear-history action, so a
// customer who clears history still sees these rows. Every arm below pins a
// distinct property; the vacuity control pins that a transcript with no
// navigation returns NOTHING while still reporting it was read.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerProfileRoutes } from '../../src/routes/profiles.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { NotFoundError } from '../../src/lib/errors.js';
import type { ProfilesService } from '../../src/services/profiles.js';
import type { AccountAuthRepo } from '../../src/services/auth.js';
import type { AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import {
  PROFILE_ACTIVITY_ENTRY_LIMIT,
  PROFILE_ACTIVITY_SESSION_LIMIT,
  projectProfileActivity,
} from '../../src/services/profile-activity.js';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const PROFILE_UUID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = `prof_${PROFILE_UUID}`;
const FOREIGN_ID = 'prof_22222222-2222-4222-8222-222222222222';

function fakeService(ownedUuid: string): ProfilesService {
  return {
    get: ({ id }: { id: string; accountId: string }) =>
      id === ownedUuid
        ? Promise.resolve({ id, accountId: ACCOUNT_ID, name: 'p', archetype: 'a' })
        : Promise.reject(new NotFoundError('Profile not found.')),
  } as unknown as ProfilesService;
}

const fakeAuthRepo = {} as unknown as AccountAuthRepo;

function entry(at: string, intents?: TranscriptEntry['intents']): TranscriptEntry {
  return { at, role: 'agent', body: '', ...(intents !== undefined ? { intents } : {}) };
}

async function buildHarness(opts: {
  agentSessions?: Pick<AgentSessionsRepo, 'listProfileActivity'>;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireAuth', (req: { account?: unknown }) => {
    req.account = { account: { id: ACCOUNT_ID, tier: 'api_builder' }, teams: [] };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerProfileRoutes(app, {
    service: fakeService(PROFILE_UUID),
    authRepo: fakeAuthRepo,
    ...(opts.agentSessions !== undefined
      ? { agentSessions: opts.agentSessions as unknown as AgentSessionsRepo }
      : {}),
  });
  await app.ready();
  return app;
}

function activity(app: FastifyInstance, id = PROFILE_ID) {
  return app.inject({
    method: 'GET',
    url: `/v1/profiles/${id}/activity`,
    headers: { authorization: 'Bearer ds_live_test' },
  });
}

describe('projectProfileActivity — the projection both repos share', () => {
  it('CRITICAL keeps ONLY navigate intents, carries the entry time and the session id, and orders most recent first ACROSS sessions', () => {
    const out = projectProfileActivity(
      [
        {
          id: 'agt_older',
          transcript: [
            entry('2026-09-05T08:00:00.000Z', [{ kind: 'navigate', url: 'https://a.example/1' }]),
            entry('2026-09-05T08:05:00.000Z', [
              { kind: 'tap', x: 1, y: 2 } as never,
              { kind: 'navigate', url: 'https://a.example/2?q=1' },
            ]),
          ],
        },
        {
          id: 'agt_newer',
          transcript: [
            entry('2026-09-05T08:02:00.000Z', [{ kind: 'navigate', url: 'https://b.example/' }]),
            entry('2026-09-05T08:03:00.000Z'), // a user turn: no intents
          ],
        },
      ],
      { sessionLimit: 10, entryLimit: 10 },
    );
    expect(out.entries.map((e) => e.url)).toEqual([
      'https://a.example/2?q=1',
      'https://b.example/',
      'https://a.example/1',
    ]);
    expect(out.entries[0]).toEqual({
      at: '2026-09-05T08:05:00.000Z',
      url: 'https://a.example/2?q=1',
      agentSessionId: 'agt_older',
    });
    expect(out.sessionsScanned).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('CRITICAL reports truncation in BOTH directions — one session over the limit, and more navigations than the entry cap — and never silently drops', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      id: `agt_${String(i)}`,
      transcript: [
        entry(`2026-09-05T08:0${String(i)}:00.000Z`, [
          { kind: 'navigate', url: `https://x.example/${String(i)}` },
          { kind: 'navigate', url: `https://y.example/${String(i)}` },
        ]),
      ],
    }));
    // Caller passes sessionLimit+1 rows, the way both repos do.
    const overSessions = projectProfileActivity(many, { sessionLimit: 3, entryLimit: 100 });
    expect(overSessions.sessionsScanned).toBe(3);
    expect(overSessions.truncated).toBe(true);
    const overEntries = projectProfileActivity(many.slice(0, 3), {
      sessionLimit: 3,
      entryLimit: 2,
    });
    expect(overEntries.entries).toHaveLength(2);
    expect(overEntries.truncated).toBe(true);
    const neither = projectProfileActivity(many.slice(0, 3), { sessionLimit: 3, entryLimit: 100 });
    expect(neither.truncated).toBe(false);
  });

  it('VACUITY CONTROL a profile whose sessions never navigated returns no rows while still reporting the sessions were READ', () => {
    const out = projectProfileActivity(
      [
        {
          id: 'agt_1',
          transcript: [entry('2026-09-05T08:00:00.000Z', [{ kind: 'tap', x: 0, y: 0 } as never])],
        },
      ],
      { sessionLimit: 10, entryLimit: 10 },
    );
    expect(out.entries).toEqual([]);
    expect(out.sessionsScanned).toBe(1);
  });
});

describe('GET /v1/profiles/:id/activity', () => {
  it('CRITICAL returns the projection in wire shape (snake_case, agent_session_id) and passes the server bounds to the store', async () => {
    const calls: unknown[] = [];
    const app = await buildHarness({
      agentSessions: {
        listProfileActivity: (args) => {
          calls.push(args);
          return Promise.resolve({
            entries: [
              {
                at: '2026-09-05T08:05:00.000Z',
                url: 'https://a.example/x',
                agentSessionId: 'agt_1',
              },
            ],
            sessionsScanned: 1,
            truncated: false,
          });
        },
      },
    });
    const res = await activity(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [
        { at: '2026-09-05T08:05:00.000Z', url: 'https://a.example/x', agent_session_id: 'agt_1' },
      ],
      sessions_scanned: 1,
      truncated: false,
    });
    expect(calls).toEqual([
      {
        accountId: ACCOUNT_ID,
        profileId: PROFILE_UUID,
        sessionLimit: PROFILE_ACTIVITY_SESSION_LIMIT,
        entryLimit: PROFILE_ACTIVITY_ENTRY_LIMIT,
      },
    ]);
    await app.close();
  });

  it('CRITICAL a foreign or unknown profile 404s BEFORE the sessions store is touched — the projection is keyed by profile id, so ownership must be settled first', async () => {
    let touched = 0;
    const app = await buildHarness({
      agentSessions: {
        listProfileActivity: () => {
          touched += 1;
          return Promise.resolve({ entries: [], sessionsScanned: 0, truncated: false });
        },
      },
    });
    const res = await activity(app, FOREIGN_ID);
    expect(res.statusCode).toBe(404);
    expect(touched).toBe(0);
    await app.close();
  });

  it('a deployment without the agent session store answers a machine-readable 503, not a 404 that reads as "no such profile"', async () => {
    const app = await buildHarness({});
    const res = await activity(app);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 503 });
    await app.close();
  });
});
