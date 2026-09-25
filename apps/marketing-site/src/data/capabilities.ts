// Cumulative-rig snapshot for marketing-surface display.
//
// Source: parent driftstack repo `/docs/progress/phase-2.md`
// cumulative-rig snapshot (probes-with-iPhone-reference denominator,
// not raw — raw includes ref=None pinned post-V-141 capture and is
// NOT the marketing-surface number).
//
// Update protocol: when the fingerprint work closes a cumulative-rig batch
// that moves the numerator or denominator, founder relays the new values
// to this repo, where the update lands as a
// Tier 1 maintenance commit (no founder review needed for factual
// technical state).
//
// Last update: 2026-05-03 founder confirmation.

// PROVENANCE — DECIDED 2026-09-15. The owner delegated every open question to the
// engineering side ("whatever needs me, you decide"), and this is the decision,
// recorded so it is not re-derived by the next sweep:
//
//   The figures below stand as a HUMAN-CONFIRMED measurement with NO artefact on
//   disk. The only cumulative-rig files in either repo belong to
//   iphone16pro_ios18_6_safari18_6 and are dated 2026-05-20, seventeen days after
//   `lastUpdated`, while the label names iOS 18.7 / Safari 26.4. Nothing decides
//   between "the numbers came from the 18.6 cell and the label moved" and "a 26.4
//   run left no file", and searching further would replace a confirmed figure with
//   the conclusion of a failed search — less evidence, called a fix.
//
//   They are superseded by the NEXT cumulative-rig run against the archetype the
//   label names, whichever number it produces, and that run must leave its
//   artefact beside this file's reference. Until then: confirmed, no artefact.
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
// from the fork's real-device-verified catalog
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
  selectableCount: 95,
  /** Device-model span of the catalog (19 iPhone models between the endpoints). */
  deviceFamilies: 'iPhone 13 → 17 Pro Max',
  /** iOS versions present in the catalog. */
  iosVersions: '18.4.1 / 18.6 / 18.7',
  /** Safari version span across the SELECTABLE catalog (18.4 through 26.6).
   *  ⚠️ Not the catalog's widest version: three 26.6.1 archetypes exist and are
   *  withheld pending a fork canvas fix, so they are not part of what a customer
   *  can pick and must not widen a breadth claim. */
  safariVersions: '18.4–26.6',
  /** ISO-8601 date the values above were last re-derived from the registry. */
  derivedOn: '2026-09-14',
} as const;
