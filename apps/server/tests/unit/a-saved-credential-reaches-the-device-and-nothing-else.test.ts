// P2 — "log in and check X" could not work, and not for a planning reason.
//
// `DecomposeArgs.credentials` and `CredentialBag` have existed since the
// interface was written. The runtime's only decompose call never populated the
// field and the Claude decomposer never read it, so a login task was planned by
// a model that had no idea a saved username existed, against an executor that
// had nothing to type. Pure plumbing.
//
// ⛔ THE DESIGN IS DECIDED BY THE TYPE'S OWN CONTRACT, not by convenience.
// CredentialBag says "never persisted in plaintext" and "rendered as [redacted]
// where applicable". A design that put the values in the prompt would break both
// — a prompt is a third-party request, it is retained in provider logs, and the
// plan it produces is replayed into the encrypted transcript and then back into
// the NEXT turn's context. So the model gets NAMES and plans a placeholder; the
// executor substitutes the value into the dispatch and nowhere else.
//
// Every arm below is about that asymmetry, because the asymmetry is the feature.

import { describe, expect, it } from 'vitest';
import {
  credentialPlaceholder,
  credentialRefsFor,
  resolveCredential,
  type CredentialBag,
} from '../../src/services/agent-decomposer.js';
import { substituteCredentials } from '../../src/services/agent-executor.js';
import {
  ControlPlaneAgentExecutor,
  summarizePageForPlanning,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import {
  decodeWireData,
  encodeWireData,
  parseIntentResult,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { StubAgentExecutor, type ExecuteArgs } from '../../src/services/agent-executor.js';
import type { DecomposeArgs, DecomposeResult } from '../../src/services/agent-decomposer.js';

const SECRET = 'hunter2-not-a-real-password';
const BAG: CredentialBag = {
  username: 'ada@example.test',
  password: SECRET,
  extras: { otp_seed: 'JBSWY3DPEHPK3PXP', blank: '' },
};

const TYPE_PASSWORD: AgentIntent = {
  kind: 'interact',
  action: 'type',
  selector: '#password',
  value: credentialPlaceholder('password'),
};

function recordingDevice(sent: Record<string, unknown>[]): IntentDispatcher {
  return {
    dispatch: (dispatch: IntentDispatch): Promise<ParsedIntentResult> => {
      const params = decodeWireData(dispatch.inputParams) as Record<string, unknown>;
      sent.push(params);
      return Promise.resolve(
        parseIntentResult(
          {
            type: 'intentResult',
            sessionId: dispatch.sessionId,
            intentId: dispatch.intentId,
            success: true,
            durationMs: 1,
            outputData: encodeWireData({
              typed_into: readString(params, 'value'),
              length: readString(params, 'text').length,
              truncated: false,
              behavioral: true,
            }),
          },
          dispatch.intentName,
        ),
      );
    },
  };
}

/**
 * Read a decoded wire param as a string.
 *
 * ⛔ NEVER `String(value)`. Params arrive from a base64 JSON decode, so a wrong
 * shape is possible, and stringifying an object hands the assertion
 * "[object Object]" as a selector or a secret — a confident value for an input
 * that was never valid.
 */
function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

describe('P2 — a saved credential reaches the device and nothing else', () => {
  it('the model is offered NAMES, and the names are exactly what the bag can resolve', () => {
    const names = credentialRefsFor(BAG);
    expect(names).toEqual(['username', 'password', 'otp_seed']);
    // ⛔ Every advertised name resolves. A name the model is told about but the
    // executor cannot resolve produces a plan that fails at dispatch time, which
    // is the worst place to discover it.
    for (const name of names) {
      expect(resolveCredential(BAG, name), name).toBeTruthy();
    }
  });

  it('an EMPTY stored value is not advertised — otherwise the plan types nothing and reports success', () => {
    expect(credentialRefsFor(BAG)).not.toContain('blank');
    expect(credentialRefsFor({})).toEqual([]);
    expect(credentialRefsFor(undefined)).toEqual([]);
  });

  it('⛔ THE SECRET REACHES THE DISPATCH', async () => {
    const sent: Record<string, unknown>[] = [];
    let n = 0;
    const executor = new ControlPlaneAgentExecutor(
      recordingDevice(sent),
      () => `int_${String((n += 1))}`,
    );
    await executor.execute({
      sessionId: 'ses_1',
      agentSessionId: 'agt_1',
      plan: { kind: 'plan', intents: [TYPE_PASSWORD], tokensConsumed: 0 },
      credentials: BAG,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(SECRET);
  });

  it('⛔ AND NOWHERE ELSE: the RESULT still carries the placeholder, so the transcript never holds the secret', async () => {
    const sent: Record<string, unknown>[] = [];
    let n = 0;
    const executor = new ControlPlaneAgentExecutor(
      recordingDevice(sent),
      () => `int_${String((n += 1))}`,
    );
    const run = await executor.execute({
      sessionId: 'ses_1',
      agentSessionId: 'agt_1',
      plan: { kind: 'plan', intents: [TYPE_PASSWORD], tokensConsumed: 0 },
      credentials: BAG,
    });
    // The transcript entry, the message response and the next turn's model
    // context are all built from these results. Serialising the whole run is
    // the only assertion that covers all three at once.
    expect(JSON.stringify(run)).not.toContain(SECRET);
    expect(JSON.stringify(run)).toContain('{{credential:password}}');
  });

  it('a substituted value is marked SENSITIVE, so the device applies no typo behaviour to a password', () => {
    const out = substituteCredentials(TYPE_PASSWORD, BAG);
    if (!out.ok) throw new Error('type narrow');
    expect(out.substituted).toBe(true);
    expect(out.intent).toMatchObject({ sensitive: true, value: SECRET });
    // The model cannot know which of its placeholders is a password, so this is
    // set here rather than trusted from the plan.
    expect(TYPE_PASSWORD).not.toHaveProperty('sensitive');
  });

  it('⛔ AN UNRESOLVED PLACEHOLDER FAILS THE STEP — it is never typed literally', async () => {
    const sent: Record<string, unknown>[] = [];
    let n = 0;
    const executor = new ControlPlaneAgentExecutor(
      recordingDevice(sent),
      () => `int_${String((n += 1))}`,
    );
    const run = await executor.execute({
      sessionId: 'ses_1',
      agentSessionId: 'agt_1',
      plan: {
        kind: 'plan',
        intents: [
          {
            kind: 'interact',
            action: 'type',
            selector: '#otp',
            value: credentialPlaceholder('missing_one'),
          },
        ],
        tokensConsumed: 0,
      },
      credentials: BAG,
    });
    // NOTHING was dispatched. Typing "{{credential:missing_one}}" into a login
    // form is accepted by the form, goes green, and is then rejected by the site
    // for a reason nothing in the turn explains — a confident silent failure.
    expect(sent).toHaveLength(0);
    expect(run.ok).toBe(false);
    expect(run.results[0]).toMatchObject({ kind: 'failure' });
    expect(String((run.results[0] as { reason: string }).reason)).toContain('missing_one');
  });

  it('a plan with no placeholders is untouched, whether or not a bag is present', () => {
    const plain: AgentIntent = {
      kind: 'interact',
      action: 'type',
      selector: '#q',
      value: 'wireless keyboard',
    };
    for (const bag of [BAG, undefined]) {
      const out = substituteCredentials(plain, bag);
      if (!out.ok) throw new Error('type narrow');
      expect(out.substituted).toBe(false);
      expect(out.intent).toBe(plain);
    }
  });

  it('⛔ a placeholder ANYWHERE BUT an interact value FAILS THE STEP — it is not quietly sent as text', () => {
    // An interact `value` is the one field a credential may be resolved into:
    // it is the text the device types and the one the `sensitive` flag covers.
    // A placeholder in a url or a selector used to pass through as a no-op, so
    // the device navigated to a literal `{{credential:password}}` and the step
    // went GREEN — the confident silent failure, with the secret's NAME on the
    // wire and no explanation anywhere in the turn.
    const cases: AgentIntent[] = [
      { kind: 'navigate', url: `https://api.test/?token=${credentialPlaceholder('password')}` },
      { kind: 'interact', action: 'tap', selector: `#${credentialPlaceholder('username')}` },
    ];
    for (const intent of cases) {
      const out = substituteCredentials(intent, BAG);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('type narrow');
      // It names the credential so the customer-facing sentence can, and says
      // WHY, because "we do not have that one" and "that is not a place it can
      // go" have completely different repairs.
      expect(out.why).toBe('unsupported_field');
      // ⛔ AND NOTHING RESOLVED. Failing closed is worthless if the value was
      // substituted on the way to the refusal.
      expect(JSON.stringify(out)).not.toContain(SECRET);
    }
  });

  it('an intent with no placeholder at all still passes through untouched', () => {
    const nav: AgentIntent = { kind: 'navigate', url: 'https://shop.test/login' };
    const out = substituteCredentials(nav, BAG);
    if (!out.ok) throw new Error('type narrow');
    expect(out.substituted).toBe(false);
    expect(out.intent).toBe(nav);
  });

  it('several placeholders in one value all resolve, and a partial match still fails closed', () => {
    const both: AgentIntent = {
      kind: 'interact',
      action: 'type',
      selector: '#combined',
      value: `${credentialPlaceholder('username')}/${credentialPlaceholder('password')}`,
    };
    const ok = substituteCredentials(both, BAG);
    if (!ok.ok) throw new Error('type narrow');
    expect(ok.intent).toMatchObject({ value: `ada@example.test/${SECRET}` });

    const partial: AgentIntent = {
      ...both,
      value: `${credentialPlaceholder('username')}/${credentialPlaceholder('nope')}`,
    };
    const bad = substituteCredentials(partial, BAG);
    // ⛔ FAIL CLOSED. A partially-substituted value would put the real username
    // on the wire beside a literal placeholder — half a secret exposed for a
    // step that cannot work anyway.
    expect(bad.ok).toBe(false);
  });
});

describe('P2 — the runtime threads the two halves to two different places', () => {
  async function runTurnWithCredentials() {
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const seenByModel: DecomposeArgs[] = [];
    const seenByExecutor: ExecuteArgs[] = [];
    const stub = new StubAgentExecutor();
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: (a: DecomposeArgs): Promise<DecomposeResult> => {
          seenByModel.push(a);
          return Promise.resolve({
            kind: 'plan',
            intents: [TYPE_PASSWORD, { kind: 'capture', capture: 'screenshot' }],
            tokensConsumed: 10,
          });
        },
      },
      executor: {
        execute: (a: ExecuteArgs) => {
          seenByExecutor.push(a);
          return stub.execute(a);
        },
      },
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'log in to mail.test and tell me how many unread messages I have',
      credentials: BAG,
    });
    return { seenByModel, seenByExecutor, sessions, seedId: seed.id };
  }

  it('⛔ THE MODEL IS HANDED NAMES AND NEVER A VALUE', async () => {
    const { seenByModel } = await runTurnWithCredentials();
    expect(seenByModel).toHaveLength(1);
    expect(seenByModel[0]?.credentialRefs).toEqual(['username', 'password', 'otp_seed']);
    // The decomposer's whole argument object is what becomes the provider
    // request. Serialising it is the assertion that covers every field at once,
    // including any added later.
    expect(JSON.stringify(seenByModel[0])).not.toContain(SECRET);
    expect(seenByModel[0]?.credentials).toBeUndefined();
  });

  it('⛔ THE EXECUTOR IS HANDED THE BAG, because it is the only layer that needs a value', async () => {
    const { seenByExecutor } = await runTurnWithCredentials();
    expect(seenByExecutor[0]?.credentials).toBe(BAG);
  });

  it('⛔ AND THE TRANSCRIPT KEEPS THE PLACEHOLDER — history is replayed into the NEXT prompt', async () => {
    const { sessions, seedId } = await runTurnWithCredentials();
    const transcript = (await sessions.get(seedId))?.transcript ?? [];
    expect(JSON.stringify(transcript)).not.toContain(SECRET);
    expect(JSON.stringify(transcript)).toContain('{{credential:password}}');
  });

  it('a session with no credentials tells the model nothing at all about credentials', async () => {
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const seenByModel: DecomposeArgs[] = [];
    const stub = new StubAgentExecutor();
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: (a: DecomposeArgs): Promise<DecomposeResult> => {
          seenByModel.push(a);
          return Promise.resolve({
            kind: 'plan',
            intents: [{ kind: 'capture', capture: 'screenshot' }],
            tokensConsumed: 10,
          });
        },
      },
      executor: { execute: (a: ExecuteArgs) => stub.execute(a) },
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'log in and check my inbox' });
    // An empty list in the prompt would advertise a capability the session does
    // not have, and the model would plan a placeholder that cannot resolve.
    expect(seenByModel[0]?.credentialRefs).toBeUndefined();
  });
});

// ── THE OTHER ROUTE INTO A PROMPT ────────────────────────────────────
//
// ⛔ EVERY ARM ABOVE GUARDS THE CREDENTIAL-BAG ROUTE, and the invariant it
// guards ("no secret reaches a model") is a claim about the WHOLE turn, not
// about one function. P1 opened a second route to the same prompt in the same
// change: the page digest. A digest that read an input's `value` would carry the
// password the executor had just carefully typed straight back up into the next
// planning call — where the transcript, the provider request and the provider
// log all keep it. The bag half would still pass every test next door.
//
// So the digest is measured against the SAME invariant, on a page shaped like
// the one a login task is looking at when the re-plan fires.
describe('P2 — the page the planner is shown carries no field contents either', () => {
  const PASSWORD = 'hunter2-not-a-real-password';
  const CSRF = 'CSRF-9f3a-SECRET-TOKEN';
  const SESSION_TOKEN = 'sess_live_9f3c21';
  const EMAIL = 'ada@example.test';
  const LOGIN_PAGE = `<!doctype html><html><head><title>Sign in</title></head><body>
    <form action="/session" method="post">
      <input type="hidden" name="authenticity_token" value="${CSRF}">
      <input type="hidden" name="session" value="${SESSION_TOKEN}">
      <input type="email" name="user" id="user" placeholder="Email address" value="${EMAIL}">
      <input type="password" name="pw" id="pw" placeholder="Password" value="${PASSWORD}">
      <button id="signin" type="submit">Sign in</button>
    </form></body></html>`;

  it('⛔ NO VALUE OF ANY FIELD APPEARS IN THE DIGEST — not the password, not the tokens, not the email', () => {
    const digest = summarizePageForPlanning(LOGIN_PAGE);
    for (const secret of [PASSWORD, CSRF, SESSION_TOKEN, EMAIL]) {
      expect(digest).not.toContain(secret);
    }
  });

  it('a hidden input earns no row at all — it is not interactive and it is where tokens live', () => {
    const digest = summarizePageForPlanning(LOGIN_PAGE);
    expect(digest).not.toContain('authenticity_token');
    expect(digest).not.toContain('[name="session"]');
  });

  it('and the digest is still USEFUL — the fields a plan needs are addressable and labelled', () => {
    const digest = summarizePageForPlanning(LOGIN_PAGE);
    // The selector and the LABEL are what a plan is written against; the
    // contents of the box are not. Dropping the value must not cost the model
    // the ability to say "type the saved username into #user".
    expect(digest).toContain('#user');
    expect(digest).toContain('Email address');
    expect(digest).toContain('#pw');
    expect(digest).toContain('Password');
    expect(digest).toContain('#signin');
    expect(digest).toContain('Sign in');
  });

  it('a value with no label is simply absent — the row is never padded out with the contents', () => {
    // The pre-fix fallback order was `text || value || placeholder`, so an input
    // with no placeholder and no label was described BY ITS CONTENTS. This is
    // that exact shape: if the digest ever mentions the number, the fallback is
    // back.
    const digest = summarizePageForPlanning(
      '<form><input type="text" name="card" value="4242424242424242"></form>',
    );
    expect(digest).toContain('input[name="card"]');
    expect(digest).not.toContain('4242');
  });
});
