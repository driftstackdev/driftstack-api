// Why a rejected harness frame must say so.
//
// `FleetControlConnection.handleInbound` dropped every frame that failed
// `HarnessOutboundSchema` with `if (!parsed.success) return;` and no log, and the
// `JSON.parse` catch above it was silent too — while the `stale` branch three
// lines up DID log. So a frame the node emitted and the CP refused was
// indistinguishable, from our side, from a frame the node never emitted.
//
// That is not hypothetical. Ledger P-29: a customer landing on a 4xx/5xx had the
// `pageState` frame REJECTED "and dropped with no log", and the row records it sat
// undetected because a source comment claimed the fork did not emit the field.
// Ledger P-30: `pageState.url`/`title` are emitted untruncated into a bounded
// schema, "over-cap frame -> silent drop -> GUI address bar freezes", and names it
// as one confirmed member of a family of unbounded emit sites. Both were invisible
// here. Today the same blindness means a missing Network-pane feed cannot be told
// apart from "the fork never emitted one".
//
// ⛔ STRUCTURE ONLY, NEVER VALUES. These frames carry customer URLs, page titles
// and cookie jars. A Zod `z.literal`/`z.enum` issue echoes the value it rejected
// (measured — see the memo on flatten() and enums), so nothing here may log an
// issue `message` or the parsed input. Only field PATHS and issue CODES leave this
// module, and the discriminator filter below drops precisely the options whose
// issues are the value-echoing kind.

import type { ZodError, ZodIssue } from 'zod';

/** Codes a union option produces when it simply is not the frame's type. An
 *  option that failed this way tells us nothing about the frame, and its issue
 *  carries the REJECTED VALUE — so these options are dropped rather than read. */
const DISCRIMINATOR_CODES = new Set(['invalid_union_discriminator', 'invalid_literal']);

/** Emitted when no union option recognised the frame's `type` at all. Distinct
 *  from a payload rejection on purpose: this is the FORWARD-COMPAT case — a newer
 *  harness sending a frame this CP does not know — and it is expected during a
 *  rollout, where a payload rejection is data loss. */
export const UNRECOGNISED_TYPE = 'unrecognised-frame-type';

/** Frame types are short identifiers on our own wire. Anything else is attacker-
 *  or bug-supplied and must not reach a log line verbatim. */
const SAFE_FRAME_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The frame's `type`, or a marker. Never returns caller-controlled text: an
 * unexpected shape becomes a fixed marker so a log line cannot be forged from a
 * frame body.
 */
export function frameTypeLabel(json: unknown): string {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return '<not-an-object>';
  const value = (json as Record<string, unknown>).type;
  if (typeof value !== 'string') return '<no-type>';
  return SAFE_FRAME_TYPE.test(value) ? value : '<unprintable-type>';
}

/**
 * A structural description of WHY the frame was refused: `field.path:issue_code`,
 * deduplicated and capped. Picks the union option that actually recognised the
 * frame's type — options that failed on the discriminator are excluded, because
 * their complaint is "I am a different frame", which is noise here.
 *
 * Returns `UNRECOGNISED_TYPE` when every option failed that way.
 */
export function describeRejection(error: ZodError, maxPaths = 6): string {
  const unionErrors = (error.issues[0] as { unionErrors?: ZodError[] } | undefined)?.unionErrors;
  const pool: ZodIssue[][] =
    unionErrors !== undefined && unionErrors.length > 0
      ? unionErrors.map((e) => e.issues)
      : [error.issues];
  const recognised = pool.filter(
    (issues) =>
      !issues.some(
        (i) => DISCRIMINATOR_CODES.has(i.code) || (i.path.length === 1 && i.path[0] === 'type'),
      ),
  );
  if (recognised.length === 0) return UNRECOGNISED_TYPE;
  // Fewest issues among the options that DID recognise the type: the closest
  // structural match, and therefore the one whose complaints describe this frame.
  const best = recognised.reduce(
    (a, b) => (b.length < a.length ? b : a),
    recognised[0] as ZodIssue[],
  );
  const seen = new Set<string>();
  for (const issue of best) {
    seen.add(`${issue.path.join('.') || '<root>'}:${issue.code}`);
    if (seen.size >= maxPaths) break;
  }
  return [...seen].join(' ');
}

/**
 * Per-connection throttle. A node emitting a malformed frame in a loop must not
 * be able to flood the log, and equally must never go fully silent — a rejection
 * that stops being reported is the defect this module exists to remove. So: the
 * first of each kind is logged, then every `EVERY`th, and the running count rides
 * along so a reader can see the true volume.
 */
export const REJECTION_LOG_EVERY = 100;
/** Distinct keys tracked per connection. Bounded because the key includes a
 *  frame type, and an unrecognised type is caller-supplied. */
export const REJECTION_KEY_CAP = 32;

export function shouldLogRejection(counts: Map<string, number>, key: string): number | null {
  const next = (counts.get(key) ?? 0) + 1;
  if (!counts.has(key) && counts.size >= REJECTION_KEY_CAP) {
    // At the cap we stop tracking NEW keys rather than evicting: eviction would
    // let an attacker rotate types to keep re-triggering the "first one" log.
    return null;
  }
  counts.set(key, next);
  return next === 1 || next % REJECTION_LOG_EVERY === 0 ? next : null;
}
