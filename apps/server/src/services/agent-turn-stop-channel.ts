// B2 — how a Stop reaches a turn that is running in ANOTHER API process.
//
// The runtime keeps the running turn's AbortController in memory, keyed by the
// agent session, and a Stop that lands on the process running the turn aborts it
// directly. Production runs one API process, so that is every Stop today. But the
// registry is in memory, and a second process answering "no turn is running"
// because the turn happens to live next door would be a Stop silently ignored —
// the customer watches the agent carry on after being told it stopped.
//
// So a process that runs a turn also CLAIMS it here, and a process that receives
// a Stop for a turn it does not hold asks here:
//
//   · claimed        → the Stop is recorded against THAT turn's id, the route
//                      answers 202 "stop requested", and the owning process —
//                      which polls while its turn runs — aborts within one poll.
//   · not claimed    → no process is running a turn for the session, and the
//                      route answers 200 "no turn running", which is now true
//                      of the whole deployment rather than of one process.
//
// WHY REDIS AND NOT A COLUMN. Redis is already a hard boot dependency of the API
// (bootstrap throws without it) and already carries per-session coordination of
// exactly this size (the pair-mode takeover lock). Keys EXPIRE, which a column
// does not: a process that dies mid-turn leaves a claim that clears itself
// instead of a row that answers "a turn is running" until something repairs it.
//
// ⛔ THE STOP IS BOUND TO A TURN ID, NOT TO THE SESSION. A stop recorded for turn
// A must never stop turn B that starts on the same session a moment later —
// which is what a per-session flag would do to the customer's next message.

import { LONGEST_TURN_THE_CONSTANTS_PERMIT_MS } from './agent-turn-bounds.js';

/** One running turn's claim, as seen from any process. */
export interface AgentTurnStopChannel {
  /** Record that `turnId` is running for `agentSessionId`. Best-effort. */
  claim(agentSessionId: string, turnId: string): Promise<void>;
  /** Drop the claim, and any stop recorded against it, if it is still `turnId`'s. */
  release(agentSessionId: string, turnId: string): Promise<void>;
  /**
   * Record a stop against whichever turn currently holds the session's claim.
   * True when a claim existed (a turn is running somewhere); false when none did.
   * Throws when the store cannot be asked — the caller must not read that as
   * "nothing is running".
   */
  requestStop(agentSessionId: string): Promise<boolean>;
  /** Whether a stop has been recorded against `turnId`. */
  stopRequested(agentSessionId: string, turnId: string): Promise<boolean>;
}

/**
 * What the TTL covers beyond the four bounds that compose a turn's tail: the
 * look before a tap, the debits and transcript writes, and the clock skew
 * between the process that writes the claim and the one that reads it.
 *
 * ⛔ WHAT IT IS NOT: cover for another dispatch. A step's retry budgets could
 * each start one, and two more deadlines would swallow any margin this size —
 * so the executor refuses to start an attempt past the turn's hard stop instead,
 * and the composition below is what that guarantees rather than a hope this
 * number absorbs it. A margin asked to cover an unbounded term is the thing the
 * literal it replaced was.
 */
const CLAIM_TTL_MARGIN_MS = 120_000;

/**
 * How long a claim and a recorded stop live — DERIVED from the bounds that
 * decide how long a turn can still be running, never asserted.
 *
 * ⛔ IT USED TO BE A LITERAL FIFTEEN MINUTES, justified as "several times the
 * longest turn that can exist". The arithmetic said otherwise: the hard stop,
 * plus the dispatch deadline of a step that started just before it, plus the
 * read-back, plus the answering call's stream cap already exceed it. A claim
 * that expires under a live turn is not a tidy-up — the recorded Stop expires
 * with it, so a customer who pressed Stop is never obeyed, and the concurrency
 * slot is handed back while the turn still holds it.
 *
 * Both halves matter and pull opposite ways, which is why the number is
 * computed: too short and a live turn outlives its claim; too long and a claim
 * orphaned by a crashed process blocks the session for as long as it lasts. The
 * guard is `the-stop-claim-outlives-the-longest-turn-the-constants-permit`,
 * which goes red the day one of those four bounds grows past this.
 */
export const AGENT_TURN_CLAIM_TTL_SECONDS = Math.ceil(
  (LONGEST_TURN_THE_CONSTANTS_PERMIT_MS + CLAIM_TTL_MARGIN_MS) / 1000,
);

/** The subset of ioredis this uses — narrowed in bootstrap, faked in tests. */
export interface AgentTurnStopRedis {
  get(key: string): Promise<string | null>;
  setEx(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  /** Atomic compare-and-delete: deletes every key in `keys` iff `keys[0]` holds `expected`. */
  deleteIfEquals(keys: readonly string[], expected: string): Promise<unknown>;
}

const claimKey = (agentSessionId: string): string => `agent_turn:claim:${agentSessionId}`;
const stopKey = (agentSessionId: string): string => `agent_turn:stop:${agentSessionId}`;

export class RedisAgentTurnStopChannel implements AgentTurnStopChannel {
  constructor(private readonly redis: AgentTurnStopRedis) {}

  async claim(agentSessionId: string, turnId: string): Promise<void> {
    await this.redis.setEx(claimKey(agentSessionId), turnId, AGENT_TURN_CLAIM_TTL_SECONDS);
  }

  async release(agentSessionId: string, turnId: string): Promise<void> {
    // Compare-and-delete, so a process releasing late cannot drop the claim of a
    // turn that has since started for the same session elsewhere.
    await this.redis.deleteIfEquals([claimKey(agentSessionId), stopKey(agentSessionId)], turnId);
  }

  async requestStop(agentSessionId: string): Promise<boolean> {
    const running = await this.redis.get(claimKey(agentSessionId));
    if (running === null || running.length === 0) return false;
    // Keyed to the turn read above. If that turn ends between the read and this
    // write, the stop names a turn that no longer exists and can stop nothing —
    // it expires on its own.
    await this.redis.setEx(stopKey(agentSessionId), running, AGENT_TURN_CLAIM_TTL_SECONDS);
    return true;
  }

  async stopRequested(agentSessionId: string, turnId: string): Promise<boolean> {
    return (await this.redis.get(stopKey(agentSessionId))) === turnId;
  }
}

/**
 * The Lua body behind {@link AgentTurnStopRedis.deleteIfEquals}: one round trip,
 * so a release can never delete a claim that changed between its read and its
 * delete.
 */
export const DELETE_IF_EQUALS_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', unpack(KEYS)) else return 0 end";

/** The ioredis calls the adapter below makes, narrowed so a test can pass the
 *  real client and nothing else is assumed about it. */
export interface IoRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * The adapter bootstrap wires, exported so the real-Redis test runs exactly the
 * commands production sends — including the Lua — rather than a copy of them.
 */
export function agentTurnStopRedisAdapter(redis: IoRedisLike): AgentTurnStopRedis {
  return {
    get: (key) => redis.get(key),
    setEx: (key, value, ttlSeconds) => redis.set(key, value, 'EX', ttlSeconds),
    deleteIfEquals: (keys, expected) =>
      redis.eval(DELETE_IF_EQUALS_LUA, keys.length, ...keys, expected),
  };
}

/** In-memory variant: several runtimes in ONE test process sharing it behave as
 *  several API processes sharing Redis. */
export class InMemoryAgentTurnStopChannel implements AgentTurnStopChannel {
  private readonly claims = new Map<string, string>();
  private readonly stops = new Map<string, string>();

  claim(agentSessionId: string, turnId: string): Promise<void> {
    this.claims.set(agentSessionId, turnId);
    return Promise.resolve();
  }

  release(agentSessionId: string, turnId: string): Promise<void> {
    if (this.claims.get(agentSessionId) === turnId) {
      this.claims.delete(agentSessionId);
      this.stops.delete(agentSessionId);
    }
    return Promise.resolve();
  }

  requestStop(agentSessionId: string): Promise<boolean> {
    const running = this.claims.get(agentSessionId);
    if (running === undefined) return Promise.resolve(false);
    this.stops.set(agentSessionId, running);
    return Promise.resolve(true);
  }

  stopRequested(agentSessionId: string, turnId: string): Promise<boolean> {
    return Promise.resolve(this.stops.get(agentSessionId) === turnId);
  }
}
