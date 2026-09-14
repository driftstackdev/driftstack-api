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

// ⚠️ OPEN QUESTION FOR THE OWNER, raised 2026-09-14 and deliberately NOT
// resolved by editing these numbers.
//
// `archetypeReference` names iPhone 16 Pro / iOS 18.7 / Safari 26.4. The only
// cumulative-rig artefacts on disk belong to iphone16pro_ios18_6_safari18_6 —
// same device, DIFFERENT iOS, DIFFERENT Safari, so a different archetype by the
// definition this site's own glossary gives — and they are dated 2026-05-20,
// seventeen days AFTER the figures below. Four further archetypes carry unified
// fork captures rather than cumrig-format files.
//
// Two readings fit and nothing in either repo decides between them: the numbers
// came from the 18.6/18.6 cell and the label was later moved to a newer
// archetype without a re-run, or a 26.4 run exists that left no artefact.
//
// ⛔ Do NOT "correct" these on the strength of the missing file. Their recorded
// provenance is a human confirmation; replacing a figure backed by that with one
// backed by a failed search substitutes LESS evidence and calls it a fix. Once
// it is known which run produced 1252/1253, this comment becomes a pointer to
// that artefact — or an explicit "confirmed, no artefact", which is also a
// legitimate answer and stops this being re-derived by the next person to sweep.
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
// Values re-derived from the registry on 2026-09-14. Update them ONLY
// by re-reading ARCHETYPE_REGISTRY — never by editing prose first; the
// cross-source-invariant tests fail if `selectableCount` or
// `verifiedCount` drifts from its own bucket in the registry.
//
// NB the homepage proof section ("iPhone 15 Pro, iPhone 16 Pro, and
// the current iPhone 17 lineup — on iOS 18.7 / Safari 26.4, and
// Safari 26.5 as it rolls out") intentionally names the flagship
// subset as curated marketing copy; it is NOT bound to this constant.
// Full-catalog claims (e.g. /roadmap) bind here.

// ⛔⛔ THREE COUNTS, THREE DIFFERENT CLAIMS. Do not substitute one for another,
// and do not put one next to a verb the others support.
//
// This block held a single `archetypeCount` until 2026-09-14, and it was
// rendered on /trust/cumulative-rig inside "the same methodology runs against
// every archetype in the catalog — N profiles". That sentence asserts the RIG
// WAS RUN. It has been run against 5. The number said 81, and the cross-source
// test guarding it compared a number to a registry length, which is true of any
// number — so the pin was green on a false claim, and moving the registry to 99
// selectable would have made it a larger false claim.
//
//   forkCaptureCount   a comprehensive fork capture exists for this archetype
//   verifiedCount      five named dimensions verified — canvas cluster, glyphHash
//                      fonts, screen geometry, inner height, configuration — by
//                      direct fork verification on some cells and by canvas
//                      -cluster membership for the rest. Cluster membership is a
//                      real equivalence class and a legitimate basis for THIS
//                      claim; it is not a basis for saying the rig ran.
//   selectableCount    offered in the product.
//
// Each is pinned separately against its own catalog bucket in
// marketing-site-data-capabilities-content-parity, so a swap reds.
export const DEVICE_SUPPORT = {
  /** Archetypes with a comprehensive fork capture (catalog `rigRun`). */
  forkCaptureCount: 5,
  /** Archetypes whose five named dimensions are verified (catalog lifecycle `bit_identical`). */
  verifiedCount: 81,
  /** Customer-selectable archetypes (registry status 'launch' | 'available'). */
  selectableCount: 99,
  /** Device-model span of the catalog (19 iPhone models between the endpoints). */
  deviceFamilies: 'iPhone 13 → 17 Pro Max',
  /** iOS versions present in the catalog. */
  iosVersions: '18.4.1 / 18.6 / 18.7',
  /** Safari version span present in the catalog (18.4 through 26.6.1). */
  safariVersions: '18.4–26.6.1',
  /** ISO-8601 date the values above were last re-derived from the registry. */
  derivedOn: '2026-09-14',
} as const;
