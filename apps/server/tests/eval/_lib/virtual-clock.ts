// Deterministic clock for the agent eval harness.
//
// WHY a hand-rolled clock rather than vitest fake timers: the executor's only
// time seam is `AutoRetryOptions.sleep`, and the thing being measured is HOW
// MUCH simulated time a plan is allowed to consume (F3's "800ms of patience
// against 2500ms needed"). A clock we own lets the fake device read the same
// `now()` the retry backoff advances, so an element with `appearsAfterMs: 2500`
// is genuinely unreachable inside the executor's retry budget rather than
// unreachable by assertion.
//
// ⛔ WHY SLEEPS RESOLVE ON A MACROTASK, NOT IMMEDIATELY. The executor's
// `observe()` races the dispatch against `sleep(observeTimeoutMs)`
// (agent-executor-control-plane.ts:255-260). A sleep that resolved on a
// microtask would race the fake device's own microtask-resolved dispatch and the
// winner would depend on tick ordering — the read-back would fire or not fire
// for reasons that are not facts about the system. Draining the sleep queue on a
// macrotask makes the instant device win that race every time, which is also
// what a real fast box does.

/** A pending sleeper, ordered by virtual deadline then insertion. */
interface Sleeper {
  deadline: number;
  seq: number;
  resolve: () => void;
}

export class VirtualClock {
  private nowMs = 0;
  private seq = 0;
  private pending: Sleeper[] = [];
  private pumpScheduled = false;
  private counted = 0;

  constructor(
    /**
     * Durations (ms) that count toward the reported simulated time.
     *
     * ⚠️ THE EXECUTOR USES `sleep` FOR THREE DIFFERENT THINGS and only two of
     * them are elapsed browsing time: the retry backoff, the cold-start
     * establish backoff, and the read-back DEADLINE. The deadline is a race
     * timer — it measures how long we are willing to wait, not time the device
     * spent — and counting it would add a flat 10s to every read-back task.
     * Selecting by duration is only sound while the three configured values are
     * distinct, which `agent-eval-scorer.test.ts` asserts directly.
     */
    private readonly countedDurations: ReadonlySet<number> = new Set<number>(),
  ) {}

  now(): number {
    return this.nowMs;
  }

  /** Advance simulated time directly — the fake device's page load, settle,
   *  wait and pause costs. */
  advance(ms: number): void {
    if (ms > 0) this.nowMs += ms;
  }

  /** Total ms of COUNTED sleeps observed so far (see `countedDurations`). */
  countedSleepMs(): number {
    return this.counted;
  }

  /** The injected `AutoRetryOptions.sleep`. Bound so it can be passed by value. */
  readonly sleep = (ms: number): Promise<void> => {
    if (this.countedDurations.has(ms)) this.counted += ms;
    return new Promise<void>((resolve) => {
      this.seq += 1;
      this.pending.push({ deadline: this.nowMs + Math.max(0, ms), seq: this.seq, resolve });
      this.schedulePump();
    });
  };

  /**
   * A CANCELLABLE sleep — the executor's `deadline` seam. A race timer that
   * loses its race (the look before a tap answered first) must leave the queue,
   * or it would later be pumped and drag the page's clock forward by the whole
   * timeout once per tap: a late render would appear "sooner" for a reason that
   * is not a fact about the page. Never counted — a deadline is how long we are
   * willing to wait, not time anything spent.
   */
  readonly deadline = (ms: number): { elapsed: Promise<void>; cancel: () => void } => {
    this.seq += 1;
    const seq = this.seq;
    let sleeper: Sleeper | undefined;
    const elapsed = new Promise<void>((resolve) => {
      sleeper = { deadline: this.nowMs + Math.max(0, ms), seq, resolve };
      this.pending.push(sleeper);
      this.schedulePump();
    });
    return {
      elapsed,
      cancel: () => {
        this.pending = this.pending.filter((pending) => pending !== sleeper);
      },
    };
  };

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      this.pumpOne();
    }, 0);
  }

  /**
   * Resolve exactly the earliest-deadline sleeper and advance the clock to it.
   *
   * One per macrotask on purpose: resolving the whole queue at once would let a
   * later-scheduled short sleep be released before work that the earlier sleep
   * is still gating, which is the ordering bug a virtual clock exists to avoid.
   */
  private pumpOne(): void {
    if (this.pending.length === 0) return;
    let bestIndex = 0;
    for (let i = 1; i < this.pending.length; i += 1) {
      const candidate = this.pending[i];
      const best = this.pending[bestIndex];
      if (candidate === undefined || best === undefined) continue;
      if (
        candidate.deadline < best.deadline ||
        (candidate.deadline === best.deadline && candidate.seq < best.seq)
      ) {
        bestIndex = i;
      }
    }
    const [next] = this.pending.splice(bestIndex, 1);
    if (next === undefined) return;
    if (next.deadline > this.nowMs) this.nowMs = next.deadline;
    next.resolve();
    if (this.pending.length > 0) this.schedulePump();
  }
}
