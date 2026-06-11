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
  const bounded = raw.length > MAX_SCREEN_CHARS ? raw.slice(0, MAX_SCREEN_CHARS) : raw;
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
 * Compile policy-authored RefusalPatternData[] into runtime RefusalPattern[].
 * BIAS-SAFE / FAIL-OPEN per entry: a malformed entry (missing field /
 * uncompilable regex) is SKIPPED, never thrown, and reported in `skipped` so a
 * silently-dead refusal rule can be alerted on rather than voiding the list.
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
    patterns.push({ id, category, match, reason });
  });
  return { patterns, skipped };
}
