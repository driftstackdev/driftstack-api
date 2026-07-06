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
  archetypeReference: 'iPhone 16 Pro / iOS 18.7 / Safari 26.4',
  /** ISO-8601 date of the last numerator/denominator update. */
  lastUpdated: '2026-05-03',
} as const;

// ── Device-support fact registry (S18) ─────────────────────────────
//
// Derivation source: packages/api-types/src/common.ts
// ARCHETYPE_REGISTRY — the customer-selectable catalog (entries with
// status 'launch' | 'available'; the single internal 'reference'
// baseline iphone15pro_ios17_5_safari17_5 is excluded), itself synced
// from Agent-1's real-device-verified catalog
// (driftstack/operations/archetype-catalog.json).
//
// Values re-derived from the registry on 2026-07-04. Update them ONLY
// by re-reading ARCHETYPE_REGISTRY — never by editing prose first; the
// cross-source-invariant tests fail if archetypeCount drifts from the
// registry.
//
// NB the homepage proof section ("iPhone 15 Pro, iPhone 16 Pro, and
// the current iPhone 17 lineup — on iOS 18.7 / Safari 26.4, and
// Safari 26.5 as it rolls out") intentionally names the flagship
// subset as curated marketing copy; it is NOT bound to this constant.
// Full-catalog claims (e.g. /roadmap) bind here.

export const DEVICE_SUPPORT = {
  /** Customer-selectable archetypes (registry status 'launch' | 'available'). */
  archetypeCount: 81,
  /** Device-model span of the catalog (19 iPhone models between the endpoints). */
  deviceFamilies: 'iPhone 13 → 17 Pro Max',
  /** iOS versions present in the catalog. */
  iosVersions: '18.6 / 18.7',
  /** Safari version span present in the catalog (18.6, 26.0, 26.3, 26.4, 26.5). */
  safariVersions: '18.6–26.5',
  /** ISO-8601 date the values above were last re-derived from the registry. */
  derivedOn: '2026-07-04',
} as const;
