#!/usr/bin/env node
// Generate ARCHETYPE_REGISTRY in packages/api-types/src/common.ts from Agent-1's
// authoritative catalog, and — with --check — fail when the two have drifted.
//
// ⛔ WHY THIS EXISTS. Until 2026-09-14 the registry was a hand-transcribed
// TypeScript literal that said it was "synced from" the catalog. Nothing
// generated it and nothing checked it, so it silently fell 24 entries behind
// (81 vs 105) while BOTH sides looked healthy: A1's freshness gate proved the
// catalog matched the archetype configs, and our build proved the registry
// compiled. Both were true. Neither was watching the join between them.
//
// This is the other half of A1's `archetype-catalog-fresh` gate. Theirs reds
// when the catalog drifts from the archetype directory; this reds when the
// registry drifts from the catalog. Between them nobody has to remember to
// re-sync, which is the point — a manual step here is a step that gets skipped,
// and its absence is invisible from both ends.
//
// Usage:
//   node scripts/gen-archetype-registry.mjs            # rewrite the block
//   node scripts/gen-archetype-registry.mjs --check    # exit 1 on drift
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

const CATALOG = '/Users/john/code/driftstack/operations/archetype-catalog.json';
const TARGET = new URL('../packages/api-types/src/common.ts', import.meta.url).pathname;
const BEGIN = '  // <generated:archetype-registry> — regenerate, do not hand-edit';
const END = '  // </generated:archetype-registry>';

/** The one entry that keeps status 'launch'; every other ready slug is 'available'. */
const LOCKED = 'iphone17_ios18_7_safari26_4';

/** Mirrors ArchetypeLifecycle in packages/api-types. An unknown value is fatal. */
const KNOWN_LIFECYCLES = new Set(['bit_identical', 'available', 'in_development', 'held']);

const strip = (value, prefix) =>
  value.startsWith(prefix) ? value.slice(prefix.length).trim() : value.trim();

/**
 * ⛔ A TRAILING ZERO PATCH ONLY, and nothing else.
 *
 * Chrome-on-iOS writes the Safari version into the iPhone-OS slot as `26_4_0`,
 * which IS Safari 26.4, so a trailing `.0` patch must compare equal. Two things
 * must NOT be normalised, and both were nearly lost here:
 *   • `18.4.1` — iOS point releases are real, distinct versions (the catalog
 *     carries iphone13_ios18_4_1_safari18_4), and merging them would collapse
 *     two different devices into one row.
 *   • `26.0` — the obvious `/(\.0)+$/` also rewrites this to `26`, and 26.0 is a
 *     real Safari version whose slug says `safari26_0`. That mismatch hit 14
 *     entries the first time this ran, caught by the label-derivation guard.
 * The rule is that a trailing `.0` PATCH means "no patch", never that a MINOR of
 * zero can be dropped.
 */
const canonicalVersion = (v) => v.replace(/^(\d+\.\d+)\.0$/, '$1');

/** (major, minor, patch-or-0) so 26.5 sorts before 26.6.1 rather than as text. */
const versionKey = (v) => {
  const [a = 0, b = 0, c = 0] = v.split('.').map((n) => Number(n) || 0);
  return a * 1_000_000 + b * 1_000 + c;
};

function entryFor(row) {
  // ⛔ The slug passes through VERBATIM. A1's catalog note makes slug == the
  // session-create archetype field, so any transform here desyncs the selector
  // from what the API accepts. Point releases now carry a THIRD component on
  // either side (`safari26_6_1`, `ios18_4_1`).
  const id = row.slug;
  const device = row.model;
  const iosVersion = canonicalVersion(strip(row.ios, 'iOS'));
  const safariVersion = canonicalVersion(strip(row.safari, 'Safari'));
  // ⛔ canvasFamily is READ, never derived. A1 asserts it per entry from the
  // config's own canvas_family field, and it is NOT a pure function of the
  // Safari version in practice: an iphone17promax built at 26.2 from a 26.4
  // template inherited 'B' when the 26.4 split makes 26.2 Family A. Deriving it
  // here would be a second implementation of a boundary that already has an
  // owner, and it would disagree with the config the fork actually loads.
  const canvasFamily = row.canvasFamily;
  // ⛔ A Chrome-on-iOS row must not be LABELLED Safari. Its slug ends `_chrome150`
  // and the label built from `safari` would have read "… / Safari 26.4" — naming
  // the wrong browser on the row's own face. (The `safariVersion` field keeps the
  // WebKit base, which is true and is what the fork actually renders with; it is
  // the customer-visible LABEL that must say Chrome.)
  const chromeMajor =
    typeof row.chromeVersion === 'string' ? row.chromeVersion.split('.')[0] : undefined;
  const browserLabel =
    row.browser === 'chrome' && chromeMajor !== undefined
      ? `Chrome ${chromeMajor}`
      : `Safari ${safariVersion}`;
  // `lifecycle` is the STRENGTH axis and is deliberately separate from `status`,
  // which is the SELECTABILITY axis. 'available' means the config is validated
  // and its UA measured at that exact cell; only 'bit_identical' means the fork
  // has been diffed byte-for-byte against a real capture. Public copy that
  // claims verification must count the latter — see DEVICE_SUPPORT.
  // ⛔ FAIL on a lifecycle we do not know, rather than defaulting it. A silent
  // fallback here would put an unrecognised value into the `available` bucket,
  // and `available` is one of the two buckets public copy counts as verified —
  // so a new catalog value would quietly inflate a verification claim on the
  // trust page. That is exactly the class of defect this generator was written
  // after. A new lifecycle is a deliberate decision on this side, not a default.
  //
  // `in_development` arrived 2026-09-14 for three archetypes the fork renders
  // with the wrong canvas family; they are held_out, so they land as `planned`
  // and are not selectable.
  const lifecycle = row.lifecycle;
  if (!KNOWN_LIFECYCLES.has(lifecycle)) {
    console.error(
      `archetype-registry: ${row.slug} has lifecycle ${JSON.stringify(lifecycle)}, which this ` +
        `generator does not know. Known: ${[...KNOWN_LIFECYCLES].join(', ')}.\n` +
        '  Add it to KNOWN_LIFECYCLES here AND to ArchetypeLifecycle in packages/api-types, and\n' +
        '  decide what public copy should count it as, before regenerating.',
    );
    exit(2);
  }
  // ⛔⛔ SELECTABILITY COMES FROM `lifecycle`, NEVER FROM `status`. The two axes
  // answer different questions and their numbers deliberately do not match:
  //
  //   status     GENERATOR-owned upstream, derived from the config validator.
  //              `ready` means "this config is well-formed" — correct UA, correct
  //              geometry, correct id. 99 rows are ready.
  //   lifecycle  A1-owned. "Should a customer be able to pick this, and how
  //              strong is the claim?" 96 rows should be offered.
  //
  // The gap is three archetypes whose configs are perfectly valid and which the
  // FORK still renders wrongly — it classifies Safari 26.6.1 as canvas Family A
  // while the config declares B, so a session would produce a wrong canvas hash.
  // The validator has no opinion about the fork's parser, so it will keep
  // computing `ready` for them until the fork is fixed.
  //
  // This mapped `status` for its first few hours and would have shipped all three
  // as selectable. Reading `status` here is not a shortcut, it is a different
  // question, and the answer it gives is "is the file well-formed" when what a
  // picker needs is "will this render correctly".
  //
  // ⚠️ The EMITTED `status` below is derived from `lifecycle` — it is not the
  // upstream validator status the paragraph above describes. So a consumer that
  // filters the generated registry on `status` (`SELECTABLE_ARCHETYPE_IDS` in
  // api-types does) is filtering on lifecycle one hop removed: change `lifecycle`
  // in the catalog and regenerate, and selectability follows. What CANNOT move
  // selectability is hand-editing `status` in the generated file — `--check` in
  // lint reds that. A peer read the headline above as "the consumer reads the
  // wrong axis"; it does not, and this sentence exists so nobody else does.
  const selectable = lifecycle === 'bit_identical' || lifecycle === 'available';
  const status = selectable ? (id === LOCKED ? 'launch' : 'available') : 'planned';
  return {
    id,
    displayLabel: `${device} / iOS ${iosVersion} / ${browserLabel}`,
    device,
    iosVersion,
    safariVersion,
    canvasFamily,
    status,
    lifecycle,
    // The SHORT form, deliberately. The long `hold_reason` is roadmap-length and
    // names the vendor policy and the internal gate; a disabled row in a
    // customer's device picker must say "blocked on a choice we are making"
    // without naming either.
    heldReason: row.heldReasonShort ?? null,
    // What a held row will BE when it lands. "based on iPhone 17 / iOS 18.7 /
    // Safari 26.4" tells a customer something about a greyed-out row; its own
    // slug does not.
    baseArchetype: typeof row.baseArchetype === 'string' ? row.baseArchetype : null,
  };
}

function render(rows) {
  const entries = rows
    .map(entryFor)
    .sort((x, y) =>
      x.device === y.device
        ? versionKey(x.safariVersion) - versionKey(y.safariVersion) ||
          versionKey(x.iosVersion) - versionKey(y.iosVersion)
        : x.device.localeCompare(y.device, 'en'),
    );
  const counts = entries.reduce((m, e) => ({ ...m, [e.lifecycle]: (m[e.lifecycle] ?? 0) + 1 }), {});
  const lines = [
    BEGIN,
    `  // ${entries.length} entries from operations/archetype-catalog.json ` +
      `(bit_identical ${counts.bit_identical ?? 0}, available ${counts.available ?? 0}, held ${counts.held ?? 0}).`,
  ];
  for (const e of entries) {
    lines.push('  {');
    // ⛔ The launch entry keeps referencing the two exported constants rather
    // than inlining their values. `LOCKED_ARCHETYPE_ID` is the v1.0 default and
    // is imported by name across the server, the client and the SDKs; a content
    // -parity pin asserts the registry's sole `status: 'launch'` row is the one
    // built from it. Emitting a literal here would leave the constant with no
    // reader in this file and quietly break that link.
    if (e.id === LOCKED) {
      lines.push('    id: LOCKED_ARCHETYPE_ID,');
      lines.push('    displayLabel: LOCKED_ARCHETYPE_DISPLAY_LABEL,');
    } else {
      lines.push(`    id: '${e.id}',`);
      lines.push(`    displayLabel: '${e.displayLabel.replace(/'/g, "\\'")}',`);
    }
    lines.push(`    device: '${e.device}',`);
    lines.push(`    iosVersion: '${e.iosVersion}',`);
    lines.push(`    safariVersion: '${e.safariVersion}',`);
    lines.push(`    canvasFamily: '${e.canvasFamily}',`);
    lines.push(`    status: '${e.status}',`);
    lines.push(`    lifecycle: '${e.lifecycle}',`);
    // ⛔ Single quotes, not JSON.stringify. The repo's prettier config rewrites
    // double-quoted strings, so a JSON.stringify here makes the file
    // format-dirty the moment it is written — and `--check` then reports DRIFT
    // on a registry that is perfectly in sync, which trains everyone to ignore
    // it. The generator has to emit what the formatter would.
    if (e.heldReason !== null) {
      lines.push(`    heldReason: '${e.heldReason.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`);
    }
    if (e.baseArchetype !== null) lines.push(`    baseArchetype: '${e.baseArchetype}',`);
    lines.push('  },');
  }
  lines.push(END);
  return lines.join('\n');
}

// ⛔ The catalog lives in the SIBLING repo, which this repo's CI does not check
// out. So the check has to distinguish "the registry has drifted" from "I could
// not look", and say which — an absent catalog reported as OK is a drift
// detector that is silent exactly where it cannot see, and an absent catalog
// reported as DRIFT reds every CI run forever until someone disables it.
//
// It SKIPS in CI and RUNS locally, which is where it matters: the pre-push gate
// runs on a machine that has both repos, so drift is caught before the commit
// leaves, not after. The skip is printed loudly rather than silently returning
// success, so a local run that unexpectedly skips is visible.
if (!existsSync(CATALOG)) {
  console.log(
    `archetype-registry-fresh: SKIPPED — ${CATALOG} is not present.\n` +
      '  This is expected in CI (the catalog is in the sibling driftstack repo, not checked out\n' +
      '  here) and NOT expected on a development machine. The pre-push gate runs locally, where\n' +
      '  both repos exist, so drift is caught there.',
  );
  exit(0);
}
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const block = render(catalog.archetypes);
const source = readFileSync(TARGET, 'utf8');
const begin = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (begin === -1 || end === -1) {
  console.error(
    `markers not found in ${TARGET} — add the generated-block markers around the entries`,
  );
  exit(2);
}
const next = `${source.slice(0, begin)}${block}${source.slice(end + END.length)}`;

if (argv.includes('--check')) {
  if (next === source) {
    console.log(`archetype-registry-fresh: OK (${catalog.archetypes.length} catalog entries)`);
    exit(0);
  }
  console.error(
    'archetype-registry-fresh: DRIFT — ARCHETYPE_REGISTRY does not match operations/archetype-catalog.json.\n' +
      'Run: node scripts/gen-archetype-registry.mjs',
  );
  exit(1);
}
writeFileSync(TARGET, next);
console.log(`wrote ${catalog.archetypes.length} entries into ${TARGET}`);
