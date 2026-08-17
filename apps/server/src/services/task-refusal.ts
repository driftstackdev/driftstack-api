// Task-refusal start-gate — A2's contract-mirror of the file-06 §Safety
// guardrail-#3 MECHANISM (W582).
//
// The canonical mechanism + contract live with Agent 3:
//   driftstack/agent-service/src/task-refusal.ts (W1027/W1028/W1051)
//   driftstack/docs/internal/task-refusal-contract.md (W1038)
// Cross-repo imports aren't a thing here, so this file MIRRORS the contract
// semantics exactly; the parity test pins this module's behavior to the
// contract (normalize order, bias-to-allow, bounds, loader skip rules).
//
// POLICY / ENGINEERING SPLIT (the load-bearing design):
//   - This module embeds ZERO policy. Patterns are INJECTED by the caller.
//   - With no patterns the gate is a NO-OP (allows everything) — so wiring the
//     run-start call ships with zero runtime-behavior change. The founder/AUP
//     curated pattern list (Tier-3) is the ONLY activation gate, and arrives
//     as pure data via loadRefusalPatterns.
//
// Engineering invariants (mirrored from the contract, not invented here):
//   - BIAS TO ALLOW: empty task / empty patterns / malformed pattern ⇒ allow.
//   - EVASION-RESISTANT: normalize (truncate → dangerous-unicode strip → NFKC
//     → lowercase → whitespace-collapse) BEFORE matching, mirroring the W444
//     classifier normalizer — a zero-width char or full-width confusable can't
//     split/hide a flagged phrase. Patterns match the NORMALIZED form.
//   - FAIL-SAFE + BOUNDED: skip non-RegExp entries; reset lastIndex on
//     global/sticky regexes; cap scanned length at 8192 chars.
//   - PURE + DETERMINISTIC: no I/O, clock, or randomness.

// The dangerous-unicode class — byte-identical to agent-service's canonical
// DANGEROUS_UNICODE (page-representation.ts, W1019/W1112): control chars (can
// split a keyword), zero-width chars (invisible splitters), bidi overrides
// (reorder what a reviewer sees), BOM. The parity test pins this source
// string against A3's definition so the two can't drift apart silently.
import { sliceWithoutSplittingSurrogate } from '../lib/bounded-text.js';

const DANGEROUS_UNICODE =
  // eslint-disable-next-line no-control-regex -- the class intentionally spans control chars
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

const MAX_SCREEN_CHARS = 8192;

/** A single refusal rule (policy-supplied; matched against the NORMALIZED task). */
export interface RefusalPattern {
  /** Stable id for telemetry / audit (which rule fired). */
  id: string;
  /** Coarse category surfaced to the customer / audit log. */
  category: string;
  /** Matcher, tested against the normalized task. */
  match: RegExp;
  /** Human-readable reason surfaced on refusal. */
  reason: string;
}

/** The decision; `refuse: false` is the conservative default for every non-match. */
export interface RefusalDecision {
  refuse: boolean;
  category?: string;
  reason?: string;
  patternId?: string;
}

/** Serializable form the policy/AUP owner authors (regex SOURCE string + flags). */
export interface RefusalPatternData {
  id: string;
  category: string;
  pattern: string;
  flags?: string;
  reason: string;
}

/**
 * Normalize an agent task into the canonical form patterns are matched
 * against. Order matters (per contract): truncate FIRST (bound the work on
 * adversarial input), then strip dangerous unicode, then NFKC-fold, then
 * lowercase, then collapse whitespace. NFKC after the strip so a stripped
 * zero-width char can't survive folding.
 */
export function normalizeTaskForScreening(task: string): string {
  const raw = typeof task === 'string' ? task : '';
  const bounded = sliceWithoutSplittingSurrogate(raw, MAX_SCREEN_CHARS);
  return bounded
    .replace(DANGEROUS_UNICODE, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Screen an agent task against an INJECTED policy pattern set. Returns the
 * first matching pattern's refusal, or `{ refuse: false }` (the conservative
 * default). Pure; called once at run-start before the first decompose.
 */
export function screenTaskForRefusal(
  task: string,
  patterns: readonly RefusalPattern[] = [],
): RefusalDecision {
  const list: readonly RefusalPattern[] = Array.isArray(patterns) ? patterns : [];
  if (list.length === 0) return { refuse: false };

  const normalized = normalizeTaskForScreening(task);
  if (normalized.length === 0) return { refuse: false };

  for (const pattern of list) {
    // Fail-safe: skip a malformed policy entry rather than throw / block.
    if (!pattern || !(pattern.match instanceof RegExp)) continue;

    const re = pattern.match;
    // Global/sticky regexes carry lastIndex across .test() calls (stateful
    // footgun) — reset so screening is deterministic.
    if (re.global || re.sticky) re.lastIndex = 0;

    if (re.test(normalized)) {
      return {
        refuse: true,
        category: pattern.category,
        reason: pattern.reason,
        patternId: pattern.id,
      };
    }
  }

  return { refuse: false };
}

/**
 * W2162/W2167 — conservative detector for the dominant catastrophic-backtracking
 * (ReDoS) structures, mirrored from the canonical agent-service detector so the
 * loader skips a hostile/badly-authored pattern BEFORE it reaches the per-task
 * `re.test` hot path. Two classes:
 *   - W2162 NESTED: an UNBOUNDED quantifier (`+`, `*`, or open-ended `{n,}`)
 *     applied to a GROUP whose body itself contains an unbounded quantifier —
 *     `(a+)+`, `(a*)*`, `(.*)+`, `(\d+){2,}`, `((a+))+`.
 *   - W2167 OVERLAPPING ALTERNATION: an unbounded quantifier on a group whose
 *     body has a top-level `|` — `(a|a)+`, `(a|aa)*`, `((a|a))+`.
 * Both compile fine but take EXPONENTIAL time on a short crafted input, blocking
 * the single-threaded event loop + stalling every co-resident run; the
 * MAX_SCREEN_CHARS cap bounds input LENGTH, not backtracking COST. Refusal
 * patterns are operator/founder-authored (the DRIFTSTACK_TASK_REFUSAL_PATTERNS
 * env / Tier-3 list), so the threat is a bad pattern + a hostile customer task —
 * this is defense-in-depth, fail-safe like the uncompilable-regex skip.
 *
 * Char-class `[...]` contents + `\`-escaped metachars are skipped (a `+`/`(`/`)`
 * there is a literal). A child group's unbounded-ness AND alternation propagate
 * to its parent so `((a+))+` / `((a|a))+` are caught. Conservative by design: it
 * may flag a benign nested/alternation pattern (→ that one rule is skipped +
 * logged), but never lets the exponential structure through.
 */
export function hasNestedQuantifier(src: string): boolean {
  const stack: Array<{ hasUnbounded: boolean; hasTopLevelAlt: boolean }> = [];
  let inClass = false;
  let lastClosedHadUnbounded = false; // did the token just before this position close an unbounded group?
  let lastClosedHadAlt = false; // …or a group with a top-level alternation (overlapping-alt ReDoS)?
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2; // escaped → literal; skip the metachar
      lastClosedHadUnbounded = false;
      lastClosedHadAlt = false;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      i++;
      lastClosedHadUnbounded = false;
      lastClosedHadAlt = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i++;
      lastClosedHadUnbounded = false;
      lastClosedHadAlt = false;
      continue;
    }
    if (ch === '(') {
      stack.push({ hasUnbounded: false, hasTopLevelAlt: false });
      i++;
      lastClosedHadUnbounded = false;
      lastClosedHadAlt = false;
      continue;
    }
    if (ch === '|') {
      // A top-level `|` INSIDE the current group makes it an alternation; if it
      // is then quantified unbounded, the run can be partitioned 2^n ways
      // (catastrophic). A `|` at the regex ROOT (no open group) can't be
      // quantified as a unit → harmless, so only mark when in a group.
      const top = stack[stack.length - 1];
      if (top) top.hasTopLevelAlt = true;
      i++;
      lastClosedHadUnbounded = false;
      lastClosedHadAlt = false;
      continue;
    }
    if (ch === ')') {
      const g = stack.pop();
      const hadU = g ? g.hasUnbounded : false;
      const hadA = g ? g.hasTopLevelAlt : false;
      const parent = stack[stack.length - 1];
      if (parent) {
        if (hadU) parent.hasUnbounded = true; // propagate so `((a+))+` is caught
        if (hadA) parent.hasTopLevelAlt = true; // …and `((a|a))+`
      }
      lastClosedHadUnbounded = hadU;
      lastClosedHadAlt = hadA;
      i++;
      continue;
    }
    // Unbounded-quantifier token? `+` `*` or an open-ended `{n,}` (bounded `{n}`/`{n,m}` are safe).
    let isUnbounded = false;
    let advance = 1;
    if (ch === '+' || ch === '*') {
      isUnbounded = true;
    } else if (ch === '{') {
      const close = src.indexOf('}', i);
      if (close > i) {
        if (/^\d*,$/.test(src.slice(i + 1, close))) isUnbounded = true; // "n," / "," → open-ended
        advance = close - i + 1;
      }
    }
    if (isUnbounded) {
      // Unbounded quantifier on a group that already held a quantifier (nested)
      // OR a top-level alternation (overlapping-alt) — both catastrophic.
      if (lastClosedHadUnbounded || lastClosedHadAlt) return true;
      const top = stack[stack.length - 1];
      if (top) top.hasUnbounded = true;
    }
    lastClosedHadUnbounded = false;
    lastClosedHadAlt = false;
    i += advance;
  }
  return false;
}

/**
 * Compile policy-authored RefusalPatternData[] into runtime RefusalPattern[].
 * BIAS-SAFE / FAIL-OPEN per entry: a malformed entry (missing field /
 * uncompilable regex / catastrophic-backtracking structure) is SKIPPED, never
 * thrown, and reported in `skipped` so a silently-dead refusal rule can be
 * alerted on rather than voiding the list.
 */
export function loadRefusalPatterns(data: unknown): {
  patterns: RefusalPattern[];
  skipped: Array<{ index: number; reason: string }>;
} {
  const patterns: RefusalPattern[] = [];
  const skipped: Array<{ index: number; reason: string }> = [];
  const arr = Array.isArray(data) ? data : [];
  arr.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      skipped.push({ index, reason: 'entry is not an object' });
      return;
    }
    const e = raw as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    const id = str(e.id);
    const category = str(e.category);
    const pattern = str(e.pattern);
    const reason = str(e.reason);
    if (!id) {
      skipped.push({ index, reason: 'missing/empty id' });
      return;
    }
    if (!category) {
      skipped.push({ index, reason: 'missing/empty category' });
      return;
    }
    if (!pattern) {
      skipped.push({ index, reason: 'missing/empty pattern' });
      return;
    }
    if (!reason) {
      skipped.push({ index, reason: 'missing/empty reason' });
      return;
    }
    const flags = typeof e.flags === 'string' ? e.flags : '';
    let match: RegExp;
    try {
      match = new RegExp(pattern, flags);
    } catch {
      skipped.push({ index, reason: 'uncompilable regex (bad source or flags)' });
      return;
    }
    // W2162/W2167: reject catastrophic-backtracking (ReDoS) patterns before they
    // reach the per-task `re.test` hot path — a nested unbounded quantifier or a
    // quantified overlapping alternation can hang the event loop + stall every
    // co-resident run (the MAX_SCREEN_CHARS cap bounds input length, not cost).
    if (hasNestedQuantifier(pattern)) {
      skipped.push({
        index,
        reason:
          'redos_complexity (nested unbounded quantifier — rewrite to avoid catastrophic backtracking)',
      });
      return;
    }
    patterns.push({ id, category, match, reason });
  });
  return { patterns, skipped };
}

export type TaskRefusalConfigIssue =
  | 'invalid_json'
  | 'not_an_array'
  | 'empty_array'
  | 'skipped_entries';

export interface TaskRefusalConfigResolution {
  configured: boolean;
  patterns: RefusalPattern[];
  skipped: Array<{ index: number; reason: string }>;
  issue: TaskRefusalConfigIssue | null;
}

/**
 * Resolve the optional environment-backed policy without performing I/O.
 *
 * An absent value intentionally leaves the gate off. Once an operator supplies
 * a value, production treats the complete list as one configuration unit: a
 * parse/shape/entry failure must stop boot instead of silently weakening the
 * declared policy. Development and test retain the loader's skip-and-inspect
 * behavior for authoring ergonomics.
 */
export function resolveTaskRefusalConfig(
  raw: string | undefined,
  nodeEnv: 'development' | 'test' | 'production',
): TaskRefusalConfigResolution {
  if (raw === undefined || raw.trim().length === 0) {
    return { configured: false, patterns: [], skipped: [], issue: null };
  }

  let parsed: unknown;
  let issue: TaskRefusalConfigIssue | null = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = [];
    issue = 'invalid_json';
  }

  const loaded = loadRefusalPatterns(parsed);
  if (issue === null) {
    if (!Array.isArray(parsed)) issue = 'not_an_array';
    else if (parsed.length === 0) issue = 'empty_array';
    else if (loaded.skipped.length > 0) issue = 'skipped_entries';
  }

  if (nodeEnv === 'production' && issue !== null) {
    throw new Error(
      `Refusing to boot: DRIFTSTACK_TASK_REFUSAL_PATTERNS is configured but ${issue}; production requires a non-empty JSON array with every rule valid.`,
    );
  }

  return {
    configured: true,
    patterns: loaded.patterns,
    skipped: loaded.skipped,
    issue,
  };
}
