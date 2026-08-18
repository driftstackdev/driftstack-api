// V-794 — two text shapes go stale by construction, and a parity pin freezing one
// guarantees a future false claim that nothing will notice.
//
// A content-parity pin proves a sentence is PRESENT in a file. It never proves the
// sentence is TRUE. That is tolerable for a sentence describing an invariant, and
// actively harmful for two shapes:
//
//   FUTURE-TENSE PROMISE — "will be wired", "is a follow-up", "not yet
//     implemented", "deferred". True when written, false the moment the work
//     lands, and the pin then holds the stale version in place: the engineer who
//     ships the feature has to fight the test that says it does not exist.
//
//   HAND-MAINTAINED COUNT — "three buckets", "15 accessors", "32 route modules",
//     "two implementations". Wrong on the next addition, and the pin cements the
//     old number. A count is derivable; freezing it as prose throws away the one
//     property that would keep it honest.
//
// An adversarial sweep over the 292 claim-bearing parity pins confirmed 57 false
// frozen claims, and 41 of them were one of these two shapes. Instances since
// closed and recorded in the log: architecture.md naming two drivers where there
// are three (V-806); an sdk-go client claiming 15 resource accessors against 19
// (V-811); a heartbeat sweep whose comment still promised a wiring that had long
// since landed (V-808); the rate-limits page rendering a table one row short of
// the enforced bucket set (V-813).
//
// That last line was WRONG when this header was first written. It listed the
// rate-limits instance among the fixes, and no fix had landed — the sweep's
// finding got transcribed as though it were a closure. It stayed wrong until
// V-813 actually did the work and read this paragraph on the way past. A header
// asserting the state of work elsewhere is itself a claim that expires, in the
// file whose whole subject is claims that expire; the log entry is the record,
// and a citation here is only safe once the V-number exists.
//
// THIS IS A RATCHET, NOT A CLEAN BILL. 172 pin files carry one of these shapes
// today; fixing them is a backlog, not a commit. The ceilings below may only
// FALL. A new pin freezing a promise about the future, or a number somebody has
// to remember to update, fails here — which is the whole point, because that is
// the moment it is cheap to write it a different way.
//
// The honest alternative, when you hit this: derive the fact. Import the constant
// and assert the rendered number equals it; count the exported accessors and
// compare; assert the wiring EXISTS rather than freezing a sentence about when it
// will. A cross-source invariant cannot go stale, because it recomputes.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const UNIT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * A promise about work not yet done. `TODO` is included because a pinned TODO is
 * the same trap with a shorter spelling.
 */
const FUTURE_TENSE =
  /\b(will (?:be )?(?:wire|wired|land|ship|shipped|add|added|replace|replaced|follow)|is a (?:V-\d+|W\d+|\d+\.\d+)?\s*follow-?up|not (?:yet )?(?:wired|implemented|live)|deferred|once .{0,40} (?:signs off|lands|ships)|TODO|coming soon)\b/i;

/**
 * A number of things that somebody has to remember to update. Deliberately scoped
 * to nouns that name an enumerable code population — "two weeks" or "three days"
 * are durations, not inventories, and are none of this guard's business.
 */
const HAND_MAINTAINED_COUNT =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,3})\s+(?:route modules|modules|accessors|buckets|implementations|endpoints|kinds|drivers|templates|files|tables|arms|categories|scopes|states|phases|sweeps|timers|chains|fields|columns)\b/i;

/**
 * MEASURED 2026-08-17 with a CORRECT extractor. May only fall; raising either is
 * the bug this file is about.
 *
 * Ratcheted 76 → 75 (futureTense) by V-841, which retired the byok-rotation pin's
 * frozen "deferred to a follow-up" wiring claim. Measured in the same breath as
 * the pin edit rather than discovered by the next full run — the first time in
 * three that this ceiling moved without the arm having to catch it.
 *
 * Ratcheted 77 → 76 (futureTense) by V-838, which retired the usage-series pin's
 * frozen "writers not wired" claim. Caught by the tight arm in the next full
 * run, exactly as the V-819 note below predicted it would be — and for the same
 * reason: I edited a pin and did not re-run this file. The note has now failed
 * to change my behaviour twice, which says the note is not the mechanism. The
 * arm is.
 *
 * Ratcheted 92 → 91 by V-819, which retired the DR checklist pin's frozen module
 * count. That correction landed in its own commit WITHOUT re-running this file,
 * and the tight arm below caught it in the next full suite — which is the arm
 * working exactly as designed, and also a reminder that it only works if the
 * suite gets run. Re-measure here after ANY pin edit that touches a numeral.
 *
 * Ratcheted 93 → 92 by V-813, which retired the rate-limits pin's frozen bucket
 * count. That file carried the shape TWICE: a `toMatch` freezing the stale count
 * in the page's own comment, and a title naming how many buckets the free tier
 * undercuts. The first was false and blocked the page from being corrected; the
 * second was true and merely fragile, and dropping the numeral made it a
 * stronger claim as well as a retired offender.
 *
 * Ratcheted 78 → 77 by V-809, which retired the network-architecture banner's
 * "once … signs off" promise.
 *
 * Ratcheted 79 → 78 by V-808, which retired the future-tense promises in the
 * agent-executor and pair-mode-heartbeat-sweep headers. Both of those files left
 * the offender set, and the tight arm below is what forced this line to move in
 * the same breath rather than leaving slack behind.
 *
 * The first values here were 89 / 94, taken with the `.not.toMatch` lookbehind
 * broken. I then "verified" the fix made no difference by comparing two variants
 * that were both broken — the comparison measured nothing and agreed with itself.
 * The fixture case below is what actually caught it.
 */
const CEILINGS = { futureTense: 75, handMaintainedCount: 91 } as const;

function parityPinFiles(): string[] {
  return readdirSync(UNIT_DIR)
    .filter((f) => f.includes('content-parity') && f.endsWith('.test.ts'))
    .map((f) => join(UNIT_DIR, f));
}

/**
 * The text a pin actually FREEZES: the body of every positive `toMatch(/…/)` plus
 * every `it()` title.
 *
 * Two exclusions, both deliberate and both load-bearing.
 *
 * `(?<!\.not\.)` — `.not.toMatch(/…/)` CONTAINS `toMatch(/…/)`, so without the
 * lookbehind a retraction sentinel is scanned as though the file froze the very
 * claim it bans. That is the shape used all through this log to stop a corrected
 * falsehood returning, so the ratchet would have fired against the fix it exists
 * to encourage: retiring a stale promise adds a sentinel quoting it, the file
 * stays an offender, and the count never falls.
 *
 * Not hypothetical: with the lookbehind broken the corpus measured 89 / 94, and
 * with it correct 79 / 93. ELEVEN files were counted as offenders purely for
 * carrying a sentinel that BANS one of these phrases — every one of them a file
 * somebody had already fixed properly. The guard was scoring the correct
 * behaviour as a violation, and the ceilings derived from it were inflated by
 * ten and one.
 *
 * The lookbehind must swallow the DOT (`\.not\.`), not just `\.not`. Written as
 * `(?<!\.not)\.?toMatch` the engine simply backtracks: it gives up the optional
 * leading dot, matches at `toMatch`, and the four preceding characters are then
 * `not.` rather than `.not`, so the negative lookbehind is satisfied and the
 * sentinel matches anyway. The fixture below caught that on the first run.
 *
 * Header comments are not scanned at all. A header saying "this used to claim X,
 * which was false" is a retraction, and counting it would penalise the correct
 * thing to write; several files in this repo now carry exactly that.
 */
function frozenText(source: string): string {
  const regexes = [...source.matchAll(/(?<!\.not\.)toMatch\(\s*\/(.*?)\/[gimsuy]*\s*[,)]/gs)].map(
    (m) => m[1] ?? '',
  );
  const titles = [...source.matchAll(/\bit\(\s*['"`](.*?)['"`]\s*,/gs)].map((m) => m[1] ?? '');
  return [...regexes, ...titles].join(' | ');
}

function offenders(pattern: RegExp): string[] {
  return parityPinFiles()
    .filter((f) => pattern.test(frozenText(readFileSync(f, 'utf8'))))
    .map((f) => f.slice(f.lastIndexOf('/') + 1))
    .sort();
}

describe('V-794 a parity pin may not freeze a claim that expires', () => {
  it('CRITICAL the scan reads real pins and really extracts frozen text. Both ceilings are upper bounds, so a scan that found nothing would satisfy them and report a clean ratchet over an empty set — the failure mode this family of guards keeps producing.', () => {
    const files = parityPinFiles();
    expect(files.length, 'content-parity pin files found').toBeGreaterThan(500);

    const extracted = files.filter((f) => frozenText(readFileSync(f, 'utf8')).length > 0).length;
    expect(extracted, 'files from which frozen text was extracted').toBeGreaterThan(500);

    // The matchers themselves, on fixtures rather than on the corpus: a pattern
    // that matched nothing would pass every ceiling below.
    expect(FUTURE_TENSE.test('the real dispatcher is not yet wired')).toBe(true);
    expect(FUTURE_TENSE.test('the sweep runs every 15 minutes')).toBe(false);
    expect(HAND_MAINTAINED_COUNT.test('documents three buckets')).toBe(true);
    expect(HAND_MAINTAINED_COUNT.test('retained for three weeks')).toBe(false);
  });

  it('CRITICAL a `.not.toMatch` sentinel is NOT read as a frozen claim. `.not.toMatch(/…/)` contains `toMatch(/…/)`, so without the lookbehind the sentinel that BANS a corrected falsehood is scanned as freezing it — the ratchet firing against the fix it exists to encourage, and every correction pushing the count the wrong way. Asserted on fixtures because the corpus cannot show it: a file would simply be miscounted in silence.', () => {
    const positive = 'expect(body).toMatch(/the dispatcher is not yet wired/);';
    const sentinel =
      "expect(body, 'must not return').not.toMatch(/the dispatcher is not yet wired/);";

    expect(frozenText(positive), 'a positive pin freezes its text').toContain('not yet wired');
    expect(frozenText(sentinel), 'a negative sentinel freezes nothing').not.toContain(
      'not yet wired',
    );

    // The realistic shape of a correction: one corrected positive plus one
    // sentinel quoting the retired falsehood. The file must not be an offender.
    const corrected = [
      'expect(body).toMatch(/the dispatcher is wired at bootstrap/);',
      sentinel,
    ].join('\n');
    expect(FUTURE_TENSE.test(frozenText(corrected)), 'a retraction is not an offender').toBe(false);
  });

  it('CRITICAL no NEW pin freezes a future-tense promise. Such a sentence is true when written and false the moment the work lands, and the pin then holds the stale version in place — the engineer shipping the feature has to fight a test asserting it does not exist. Assert the wiring exists instead, or say nothing about the schedule.', () => {
    const found = offenders(FUTURE_TENSE);
    expect(
      found.length,
      `${String(found.length)} pin files freeze a future-tense promise; the ceiling is ${String(
        CEILINGS.futureTense,
      )} and may only fall. If you added one: state what IS true, or assert the wiring rather than the plan. Current set:\n${found.join('\n')}`,
    ).toBeLessThanOrEqual(CEILINGS.futureTense);
  });

  it('CRITICAL no NEW pin freezes a hand-maintained count. A number of modules, accessors, buckets or drivers is wrong on the next addition, and the pin cements the old one. Counts are derivable — import the constant, or count the exports and compare; a cross-source invariant recomputes and cannot go stale.', () => {
    const found = offenders(HAND_MAINTAINED_COUNT);
    expect(
      found.length,
      `${String(found.length)} pin files freeze a hand-maintained count; the ceiling is ${String(
        CEILINGS.handMaintainedCount,
      )} and may only fall. If you added one: derive the number instead of freezing it. Current set:\n${found.join('\n')}`,
    ).toBeLessThanOrEqual(CEILINGS.handMaintainedCount);
  });

  it('CRITICAL the ceilings are not slack. A ceiling set comfortably above the real count is a guard that never fires, and would let the next dozen through unnoticed — so each is pinned to the measured value with no headroom. When a batch of corrections retires an offender, LOWER the ceiling in that commit; this arm is what makes that mandatory rather than optional.', () => {
    expect(offenders(FUTURE_TENSE).length, 'ratchet is tight against reality').toBe(
      CEILINGS.futureTense,
    );
    expect(offenders(HAND_MAINTAINED_COUNT).length, 'ratchet is tight against reality').toBe(
      CEILINGS.handMaintainedCount,
    );
  });
});
