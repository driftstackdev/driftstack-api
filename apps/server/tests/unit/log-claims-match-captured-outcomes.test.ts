// A log message is an assertion, and nothing typechecks it.
//
// `SessionsService.create` had a post-dispatch failure path that released the
// reserved concurrency slot and tore down the now-orphaned worker, both
// deliberately best-effort so neither could mask the customer-visible error.
// Both results were discarded with `.catch(() => {})`, and the line beneath
// them read, unconditionally:
//
//   'session post-dispatch DB write failed — released the leaked concurrency
//    slot + tore down the orphaned worker'
//
// So it read identically when neither had happened. The two failures it
// absorbed are the expensive ones: a slot that was never released counts
// against the tier cap forever, and a worker that survived teardown is a real
// browser with nothing left that will ever reap it. An operator reading that
// line during an incident would rule out both.
//
// The message was not stale and was not wrong when written — it described the
// intended path accurately and simply never re-derived whether that path had
// been taken. That is the class this guard closes: a completed-action claim
// sitting next to an outcome the code threw away.
//
// This guard HUNTS a violation, so zero is its expected state and counting
// subjects cannot floor it. The synthetic arm below is what makes the zero
// mean something — it feeds the detector the real pre-fix source shape and
// requires a hit.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

/**
 * An awaited call whose failure is thrown away entirely.
 *
 * `false` and `null` are deliberately absent. Both are sentinels a caller
 * branches on — `.then(() => true).catch(() => false)` is exactly how the
 * sessions fix captures the outcome, and `.catch(() => null)` binds a value
 * the next line reads. Treating those as discards reported the FIXED code as
 * defective, which is how this list got written the first time.
 */
const DISCARDS = /\.catch\(\s*\(\s*\)\s*=>\s*(?:\{\s*\}|undefined|void 0)\s*\)/;

/**
 * Discarded outcomes that genuinely carry no signal. Cancelling an unread
 * response body cannot fail in a way anyone can act on, and a message near one
 * is describing the request, not the cancel.
 */
const BENIGN = /\.(?:body\??\.)?cancel\(\)|reader\.cancel\(\)|\.end\(\{|clearTimeout|\.unref\(\)/;

/**
 * A message asserting the action COMPLETED.
 *
 * Past tense only, and that distinction is the whole point: "releasing the
 * slot" or "attempting to tear down the worker" describe an attempt and stay
 * true when the attempt fails. "released" does not.
 */
const CLAIMS_DONE =
  /'[^']*\b(?:released|tore down|torn down|destroyed|deleted|purged|revoked|reclaimed|rolled back|reverted|cleaned up|cancelled|canceled|removed|flushed|drained|persisted|committed|restored)\b[^']*'/i;

/**
 * How far a claim can sit from the discard and still be about it.
 *
 * 16 was too small and the guard was VACUOUS because of it — found 2026-08-07 by
 * re-mutating the real defect back into sessions.ts, which the guard passed. A
 * production log call carries a 6-field object plus a rationale comment, so the
 * message sits 22 and 16 lines after its capture at the two real sites. The
 * synthetic arm below used a compact 4-field object and therefore passed while
 * the real shape escaped: the control was easier than reality, which is the only
 * way a positive control can lie.
 */
const WINDOW = 40;

interface Offender {
  file: string;
  discardLine: number;
  claimLine: number;
  claim: string;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Completed-action claims sitting within WINDOW lines of a discarded outcome. */
function claimsNextToDiscardedOutcomes(source: string, file: string): Offender[] {
  const lines = source.split('\n');
  const found: Offender[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!DISCARDS.test(line) || BENIGN.test(line)) continue;
    for (let j = i + 1; j < Math.min(i + WINDOW, lines.length); j++) {
      const candidate = lines[j] ?? '';
      if (!CLAIMS_DONE.test(candidate)) continue;
      found.push({ file, discardLine: i + 1, claimLine: j + 1, claim: candidate.trim() });
      break;
    }
  }
  return found;
}

/**
 * The real pre-fix shape, reduced to the two lines that mattered. Kept verbatim
 * rather than paraphrased so the arm stays a test of the detector and not of a
 * fixture written to suit it.
 */
const KNOWN_BAD = `
      // Tear down the LIVE driver/browser session. Marking the row 'errored' +
      // stamping destroyedAt frees the DB cap slot, but the duration sweeper only
      // reaps ACTIVE_SESSION_STATUSES and destroy() short-circuits 'errored' — so
      // without this the real browser leaks forever on every transient error.
      // Best-effort, mirroring create()'s orphan guard; the original error wins.
      await destroyDriverSessionWithTimeout(() =>
        this.deps.driver.destroy(session.driverSessionId),
      ).catch(() => {});
      try {
        this.deps.logger?.error?.(
          {
            component: 'sessions-service',
            event: 'post_dispatch_bind_failed',
            account_id: accountId,
            session_id: reserved.id,
            driver_session_id: driverResult.driverSessionId,
            err,
          },
          'session post-dispatch DB write failed — released the leaked concurrency slot + tore down the orphaned worker',
        );
      } catch {
        // Swallow; logging is best-effort.
      }
`;

const sourceFiles = walk(SRC).filter((f) => f.endsWith('.ts'));

describe('log messages do not claim outcomes the code discarded', () => {
  it('CRITICAL the detector fires on the real pre-fix source shape. The assertion below reports an ABSENCE, so a matcher that stopped matching satisfies it having inspected nothing — and zero is this guard\'s expected state, which means nothing else can distinguish "clean" from "blind".', () => {
    const hits = claimsNextToDiscardedOutcomes(KNOWN_BAD, 'known-bad.ts');
    expect(hits, 'the detector must report the shape it exists to catch').toHaveLength(1);
    expect(hits[0]?.claim).toContain('tore down the orphaned worker');

    // Present tense is an attempt, not a claim, and must NOT be reported —
    // otherwise the only way to satisfy this guard is to stop logging.
    expect(
      claimsNextToDiscardedOutcomes(
        KNOWN_BAD.replace(
          'released the leaked concurrency slot + tore down',
          'releasing the leaked concurrency slot + tearing down',
        ),
        'attempt.ts',
      ),
      'a message describing an ATTEMPT stays true when the attempt fails',
    ).toEqual([]);

    // And a captured outcome clears it: the claim is conditional on the result.
    expect(
      claimsNextToDiscardedOutcomes(
        KNOWN_BAD.replace('.catch(() => {});', '.then(() => true).catch(() => false);'),
        'captured.ts',
      ),
      'an outcome that is captured is not a discarded outcome',
    ).toEqual([]);
  });

  it('CRITICAL the scan reached the server source and that source still contains discarded outcomes. Without this a wrong scan root reports the same clean result as a clean tree.', () => {
    expect(sourceFiles.length, 'server source files scanned').toBeGreaterThan(100);
    const discarding = sourceFiles.filter((f) => DISCARDS.test(readFileSync(f, 'utf8')));
    expect(
      discarding.length,
      'files containing a discarded-outcome call — if this hits zero the pattern stopped matching',
    ).toBeGreaterThan(5);
  });

  it('CRITICAL no completed-action log claim sits next to an outcome the code threw away. Such a line reads identically whether or not the thing it names happened, and it is read during incidents.', () => {
    const offenders = sourceFiles.flatMap((f) =>
      claimsNextToDiscardedOutcomes(readFileSync(f, 'utf8'), relative(REPO_ROOT, f)),
    );
    expect(
      offenders.map(
        (o) =>
          `${o.file}:${o.claimLine} claims "${o.claim}" (outcome discarded at :${o.discardLine})`,
      ),
      'log claim(s) asserting an outcome the code did not capture — capture the result and make the wording conditional on it, or describe the attempt in present tense:',
    ).toEqual([]);
  });
});
