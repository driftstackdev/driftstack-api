// Which Postgres notices the e2e harness provokes on purpose.
//
// The harness is destructive by design: it runs `DROP SCHEMA … CASCADE` twice at
// startup to make the suite hermetic, and `TRUNCATE … RESTART IDENTITY CASCADE`
// before every test. Postgres reports each cascade as a NOTICE, and postgres-js
// writes notices with `console.log` as a raw ANSI-coloured object dump.
//
// MEASURED on a full green run: 1,988 of 2,645 log lines — 75% of the entire
// output — were those dumps. A Playwright failure is read by scrolling, and
// three quarters of the scrollback was the harness announcing that the schema it
// had just asked to drop had in fact dropped.
//
// The harness already filtered for this, and the filter under-covered its own
// output. It tested `/^truncate cascades to table/` against `notice.message`,
// which is right for TRUNCATE — one notice per table, the table named in the
// message. DROP SCHEMA does not report that way:
//
//     message: 'drop cascades to 69 other objects'
//     detail:  'drop cascades to type account_status\n
//               drop cascades to table accounts\n …'   (69 lines)
//
// The list is in `detail`, a field the old filter never read, and the summary
// line says "drop", not "truncate". So every DROP notice fell through to the
// default branch and printed whole — which is exactly the 1,988 lines.
//
// WHY THIS IS NOT A BLANKET SWALLOW. The reason the harness filtered instead of
// silencing is that a notice which means something — a migration warning, a
// skipped DDL — is worth seeing. That property is kept and made stricter here:
// the summary must be cascade chatter AND every line of the detail must be too.
// A notice that opens with a cascade line and carries something else below it
// still prints, which a `startsWith` check on the summary alone would hide.

/** The one sentence Postgres emits per cascaded object, for either statement. */
const CASCADE_CHATTER = /^(truncate|drop) cascades to /i;

/** The fields of a postgres-js notice this predicate reads. */
export interface NoticeLike {
  message?: unknown;
  detail?: unknown;
}

/**
 * True when a notice is nothing but the cascade chatter this harness asks for.
 *
 * Both halves are required. The summary must be cascade chatter, and — because
 * DROP SCHEMA puts its list in `detail` — every non-empty detail line must be as
 * well. Anything else rode along in a notice we would otherwise have silenced.
 */
/**
 * A notice field as text.
 *
 * Narrowed rather than `String(...)`-cast: these fields are typed `unknown`, and
 * stringifying an unexpected object yields the literal "[object Object]", which
 * matches no pattern here and would be silently treated as "not chatter" for the
 * wrong reason. Returning '' for a non-string reaches the same verdict on
 * purpose — an unrecognisable notice PRINTS, which is the safe direction.
 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function isExpectedCascadeChatter(notice: NoticeLike): boolean {
  if (!CASCADE_CHATTER.test(asText(notice.message))) return false;

  const detail = asText(notice.detail);
  if (detail.trim() === '') return true;

  return detail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .every((line) => CASCADE_CHATTER.test(line));
}

/**
 * A notice worth keeping, rendered as ONE line.
 *
 * The raw object dump is the other half of the problem: even a notice that
 * should print costs ~40 lines of scrollback and arrives ANSI-coloured, so it
 * cannot be grepped out of a CI artifact. One line per notice keeps the signal
 * and drops the cost.
 */
export function formatNotice(notice: NoticeLike & { severity?: unknown; code?: unknown }): string {
  return JSON.stringify({
    msg: 'postgres notice in e2e harness',
    severity: asText(notice.severity),
    code: asText(notice.code),
    detail: asText(notice.message),
  });
}
