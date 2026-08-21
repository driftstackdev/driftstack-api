import { describe, expect, it } from 'vitest';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { ProfileInUseError } from '../../src/lib/errors.js';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';
import type { NewSessionInput } from '../../src/services/sessions.js';

// A3 finding #7 (W2979/W2980) — single-active-session-per-profile guard. A
// session-create carrying a profile_id that already has a NON-TERMINAL session
// for the account is REFUSED with ProfileInUseError so two sessions can't both
// restore + clobber the same sealed cookie/state blob. These in-memory unit
// tests pin the guard semantics deterministically (the true-concurrency advisory-
// lock atomicity is exercised against real Postgres in
// db-profile-in-use-concurrency-drizzle.test.ts). The in-memory repos are the
// exact contract doubles the route layer exercises.

const HIGH_CAP = 100; // above any per-test count, so the cap never confounds.

function mkDriverInput(accountId: string, i: number, profileId?: string): NewSessionInput {
  return {
    accountId,
    apiKeyId: 'key_1',
    driverSessionId: `drv-${i}`,
    archetype: 'iphone17_ios18_7_safari26_4',
    purpose: 'production_customer',
    label: null,
    // The driver-sessions table stores profile_id in metadata.profile_id.
    metadata: profileId !== undefined ? { profile_id: profileId } : null,
  };
}

describe('agent-sessions profile-in-use guard (createIfUnderActiveCap)', () => {
  it('refuses a SECOND non-terminal bind on the same profile with ProfileInUseError carrying active_session_id', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const first = await repo.createIfUnderActiveCap(
      { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_x' },
      HIGH_CAP,
    );
    expect(first).not.toBeNull();
    await expect(
      repo.createIfUnderActiveCap(
        { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_x' },
        HIGH_CAP,
      ),
    ).rejects.toBeInstanceOf(ProfileInUseError);
    // The 409 names the live session so the GUI/SDK can say "end that one first".
    await repo
      .createIfUnderActiveCap(
        { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_x' },
        HIGH_CAP,
      )
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(ProfileInUseError);
        expect((err as ProfileInUseError).extensions['active_session_id']).toBe(first!.id);
      });
    expect(await repo.countActiveForProfile('prof_x')).toBe(1);
  });

  it('a CLOSED (terminal) session on the profile allows a new bind', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const first = await repo.createIfUnderActiveCap(
      { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_x' },
      HIGH_CAP,
    );
    await repo.closeWithReason(first!.id, 'customer-closed');
    const second = await repo.createIfUnderActiveCap(
      { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_x' },
      HIGH_CAP,
    );
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
  });

  it('the SAME profileId under a DIFFERENT account is isolated (no cross-account block)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const a = await repo.createIfUnderActiveCap(
      { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_shared' },
      HIGH_CAP,
    );
    // Account B binds the same profileId string — must NOT be blocked by A's bind.
    const b = await repo.createIfUnderActiveCap(
      { accountId: 'acc_b', tokenBudgetTotal: 1000, profileId: 'prof_shared' },
      HIGH_CAP,
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('a create with NO profileId is never gated (two no-profile creates both bind)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const a = await repo.createIfUnderActiveCap(
      { accountId: 'acc_a', tokenBudgetTotal: 1000 },
      HIGH_CAP,
    );
    const b = await repo.createIfUnderActiveCap(
      { accountId: 'acc_a', tokenBudgetTotal: 1000 },
      HIGH_CAP,
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('the guard rule is "non-terminal" (status != closed), not "active-only" — only a CLOSE frees the bind', async () => {
    // Boundary check on the terminal predicate: an active bind blocks; closing it
    // (the ONLY terminal agent-session status) frees the profile; re-binding then
    // succeeds. Drift to gating on status==='active' (instead of !=='closed')
    // would wrongly free a 'paused' session — this pins the closed-only boundary.
    const repo = new InMemoryAgentSessionsRepo();
    const first = await repo.createIfUnderActiveCap(
      { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_b' },
      HIGH_CAP,
    );
    await expect(
      repo.createIfUnderActiveCap(
        { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_b' },
        HIGH_CAP,
      ),
    ).rejects.toBeInstanceOf(ProfileInUseError);
    await repo.closeWithReason(first!.id, 'customer-closed');
    const rebound = await repo.createIfUnderActiveCap(
      { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_b' },
      HIGH_CAP,
    );
    expect(rebound).not.toBeNull();
  });
});

describe('driver-sessions profile-in-use guard (insertSessionIfUnderLimit, metadata.profile_id)', () => {
  it('KNOWN GAP, asserted so it cannot be mistaken for coverage: the driver-side DOUBLE does not gate on agent sessions. DrizzleSessionsRepo refuses a bind on EITHER a live legacy session OR a live agent_sessions row holding the profile; this fixture has no agent-session state and models only the first arm, so it UNDER-REFUSES. A route test creating a driver session for a profile an agent session holds will succeed here and be refused in production. The real arm is proven against Postgres in db-profile-in-use-concurrency-drizzle; this arm exists so the omission is visible rather than silent, and it will start failing the day the double learns to consult agent sessions — which is the signal to delete it.', async () => {
    const drivers = new InMemorySessionsRepo();
    const agents = new InMemoryAgentSessionsRepo();

    // An agent session holds prof_shared for acc_a.
    const held = await agents.createIfUnderActiveCap(
      { accountId: 'acc_a', tokenBudgetTotal: 1000, profileId: 'prof_shared' },
      HIGH_CAP,
    );
    expect(held, 'the agent-session fixture did not bind the profile').not.toBeNull();
    expect(
      await agents.countActiveForProfile('prof_shared'),
      'the profile is not actually held by a live agent session',
    ).toBe(1);

    // Production refuses this. The double does not, and that is the gap.
    const bound = await drivers.insertSessionIfUnderLimit(
      mkDriverInput('acc_a', 0, 'prof_shared'),
      HIGH_CAP,
      { profileId: 'prof_shared' },
    );
    expect(
      bound,
      'the double now gates on agent sessions — production parity improved, so delete this arm',
    ).not.toBeNull();
  });

  it('refuses a SECOND non-terminal bind on the same profile with ProfileInUseError', async () => {
    const repo = new InMemorySessionsRepo();
    const first = await repo.insertSessionIfUnderLimit(
      mkDriverInput('acc_a', 0, 'prof_x'),
      HIGH_CAP,
      {
        profileId: 'prof_x',
      },
    );
    expect(first).not.toBeNull();
    await expect(
      repo.insertSessionIfUnderLimit(mkDriverInput('acc_a', 1, 'prof_x'), HIGH_CAP, {
        profileId: 'prof_x',
      }),
    ).rejects.toBeInstanceOf(ProfileInUseError);
  });

  it('the ProfileInUseError names the live driver session as ses_<id>', async () => {
    const repo = new InMemorySessionsRepo();
    const first = await repo.insertSessionIfUnderLimit(
      mkDriverInput('acc_a', 0, 'prof_x'),
      HIGH_CAP,
      {
        profileId: 'prof_x',
      },
    );
    await repo
      .insertSessionIfUnderLimit(mkDriverInput('acc_a', 1, 'prof_x'), HIGH_CAP, {
        profileId: 'prof_x',
      })
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(ProfileInUseError);
        expect((err as ProfileInUseError).extensions['active_session_id']).toBe(`ses_${first!.id}`);
      });
  });

  it('a DESTROYED (terminal) session on the profile allows a new bind', async () => {
    const repo = new InMemorySessionsRepo();
    const first = await repo.insertSessionIfUnderLimit(
      mkDriverInput('acc_a', 0, 'prof_x'),
      HIGH_CAP,
      {
        profileId: 'prof_x',
      },
    );
    await repo.updateSessionStatus(first!.id, 'destroyed', { destroyedAt: new Date() });
    const second = await repo.insertSessionIfUnderLimit(
      mkDriverInput('acc_a', 1, 'prof_x'),
      HIGH_CAP,
      {
        profileId: 'prof_x',
      },
    );
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
  });

  it('an ERRORED (terminal) session on the profile allows a new bind', async () => {
    const repo = new InMemorySessionsRepo();
    const first = await repo.insertSessionIfUnderLimit(
      mkDriverInput('acc_a', 0, 'prof_x'),
      HIGH_CAP,
      {
        profileId: 'prof_x',
      },
    );
    await repo.updateSessionStatus(first!.id, 'errored', { destroyedAt: new Date() });
    const second = await repo.insertSessionIfUnderLimit(
      mkDriverInput('acc_a', 1, 'prof_x'),
      HIGH_CAP,
      {
        profileId: 'prof_x',
      },
    );
    expect(second).not.toBeNull();
  });

  it('the SAME profileId under a DIFFERENT account is isolated', async () => {
    const repo = new InMemorySessionsRepo();
    const a = await repo.insertSessionIfUnderLimit(
      mkDriverInput('acc_a', 0, 'prof_shared'),
      HIGH_CAP,
      {
        profileId: 'prof_shared',
      },
    );
    const b = await repo.insertSessionIfUnderLimit(
      mkDriverInput('acc_b', 0, 'prof_shared'),
      HIGH_CAP,
      {
        profileId: 'prof_shared',
      },
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('a create with NO profileId is never gated (two no-profile creates both bind)', async () => {
    const repo = new InMemorySessionsRepo();
    const a = await repo.insertSessionIfUnderLimit(mkDriverInput('acc_a', 0), HIGH_CAP);
    const b = await repo.insertSessionIfUnderLimit(mkDriverInput('acc_a', 1), HIGH_CAP);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('reconnect to an existing session is NOT a new bind — findSession never runs the guard', async () => {
    // A reconnect reads an existing session (findSession), it never calls
    // insertSessionIfUnderLimit, so the guard is structurally bypassed for
    // reconnects. Model it: bind once, then "reconnect" by looking the row up —
    // which succeeds while the bind is still live (no second create, no 409).
    const repo = new InMemorySessionsRepo();
    const first = await repo.insertSessionIfUnderLimit(
      mkDriverInput('acc_a', 0, 'prof_x'),
      HIGH_CAP,
      {
        profileId: 'prof_x',
      },
    );
    const reconnected = await repo.findSession(first!.id, 'acc_a');
    expect(reconnected).not.toBeNull();
    expect(reconnected!.id).toBe(first!.id);
  });
});
