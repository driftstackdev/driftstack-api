// Cumulative-rig snapshot for marketing-surface display.
//
// Source: parent driftstack repo `/docs/progress/phase-2.md`
// cumulative-rig snapshot (probes-with-iPhone-reference denominator,
// not raw — raw includes ref=None pinned post-V-141 capture and is
// NOT the marketing-surface number).
//
// Update protocol: when Agent 1 closes a cumulative-rig batch that
// moves the numerator or denominator, founder relays the new values
// to Agent 2 in next interaction; Agent 2 lands the update as a
// Tier 1 maintenance commit (no founder review needed for factual
// technical state).
//
// Last update: 2026-05-03 founder confirmation.

export const CUMULATIVE_RIG = {
  /** Surfaces matching the iPhone reference fingerprint exactly. */
  surfacesMatched: 1252,
  /** Surfaces measured against the iPhone reference (excludes ref=None). */
  surfacesMeasured: 1253,
  /** Pre-rounded percentage for marketing-headline display. */
  matchRatePercentage: 99.9,
  /** Reference archetype the cumulative rig measures against. */
  archetypeReference: 'iPhone 16 Pro / iOS 26.4.1',
  /** ISO-8601 date of the last numerator/denominator update. */
  lastUpdated: '2026-05-03',
} as const;
