// Nothing may hand an agent intent to a client without redacting it first.
//
// `services/agent-public-redaction.ts` exists for one stated reason:
//
//   Keep one shared projection here so recipes, live transcript SSE, and turn
//   responses cannot drift into different policies.
//
// What it redacts is the `value` of a sensitive `type` intent — the literal text
// a user typed into a password field during a recorded session. The runtime
// deliberately keeps that exact value in the encrypted transcript so a
// consequential-action confirmation can replay the reviewed plan, which means the
// unredacted value is genuinely present on every record a route handler touches.
// The projection is the only thing standing between it and the wire.
//
// The projection itself is well tested, and two content-parity tests pin two
// known call sites. Neither catches the case that actually matters: a NEW
// surface — another SSE event, another turn-response field, another recipe view —
// that emits intents and forgets to project them. Every existing site is correct
// today; nothing keeps the next one honest.
//
// So this is a source-shape guard rather than a behavioural one, deliberately: it
// has to fail for code that does not exist yet, which no runtime assertion can
// do. It works by enumerating the SET of places routes touch intent data and
// requiring each one to either project or be a named, justified exception.
// Adding an emission point changes the set and reds this test, which forces the
// decision to be made rather than defaulted.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES_DIR = join(import.meta.dirname, '../../src/routes');

/** The three shared projections. Any one of them satisfies a site. */
const PROJECTIONS = ['publicAgentIntent', 'publicIntentResult', 'publicTranscriptEntry'];

/**
 * Sites that touch intent data WITHOUT projecting, each deliberate. Matched on
 * exact trimmed source text, so moving a line is fine but changing what it does
 * drops the exemption and re-reds the guard.
 *
 *   flatMap(...)               builds the recipe's STORED intent_log from the
 *                              source transcript. That record is the encrypted
 *                              replay copy and is meant to retain exact values;
 *                              redaction happens on the way OUT, in
 *                              publicRecipeDetail. (Appears twice, identically.)
 *   suggestRecipeMetadata(...) derives a title and description. Verified to read
 *                              only navigate hostnames and intent COUNTS — it
 *                              never touches `.value`, so a typed password
 *                              cannot reach a suggested recipe name.
 *   intentLog,                 the stored write, same replay copy as above.
 *   *.length                   counts, carrying no values.
 */
const JUSTIFIED_UNPROJECTED = [
  'const intentLog: AgentIntent[] = source.transcript.flatMap((entry) => entry.intents ?? []);',
  'const suggestion = suggestRecipeMetadata(intentLog);',
  'intentLog,',
  'intent_count: rec.intentLog.length,',
  'intent_count: intentLog.length,',
];

interface Site {
  file: string;
  line: number;
  text: string;
}

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();
}

/** Every line in a route file that reads intent data off a record. */
function intentSites(): Site[] {
  const sites: Site[] = [];
  for (const file of routeFiles()) {
    const lines = readFileSync(join(ROUTES_DIR, file), 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const text = raw.trim();
      // Skip comments and import/type positions — neither reaches a response.
      if (text.startsWith('//') || text.startsWith('*') || text.startsWith('import ')) return;
      // Keyed on the DATA, never on the call shape. An earlier version of this
      // matched `.results.map(` and `.intents` — both of which stop matching the
      // moment the projection is deleted, so removing a projection removed the
      // site from the scan and the guard passed. Mutation testing caught it.
      // These patterns name the intent-bearing accessors themselves, so a site
      // cannot leave the set by dropping its redaction.
      if (/\.intents\b|\bintentLog\b|executor\.results\b|\bentry:\s/.test(text)) {
        sites.push({ file, line: i + 1, text });
      }
    });
  }
  return sites;
}

describe('agent intent emission', () => {
  it('CRITICAL the scan finds the known emission sites, so a green is not an empty sweep', () => {
    const sites = intentSites();
    // A rename or a moved directory would otherwise make this file pass by
    // finding nothing at all.
    expect(
      sites.length,
      'the scan matched nothing — it is no longer looking at the routes',
    ).toBeGreaterThanOrEqual(12);
    expect(
      new Set(sites.map((s) => s.file)),
      'the known intent-emitting route files are no longer being scanned',
    ).toEqual(new Set(['agent-sessions.ts', 'recipes.ts']));
  });

  it('CRITICAL every site that hands intent data to a client projects it first', () => {
    const offenders = intentSites()
      .filter((s) => !PROJECTIONS.some((p) => s.text.includes(p)))
      .filter((s) => !JUSTIFIED_UNPROJECTED.includes(s.text));
    expect(
      offenders.map((s) => `${s.file}:${s.line.toString()} ${s.text}`),
      'a route reads agent intent data and sends it on without the shared public projection. The ' +
        'encrypted record retains the exact text a user typed into a sensitive field — a password ' +
        'entered during a recorded session — and this projection is the only thing that strips it ' +
        'before the value reaches a client. Either wrap the site in publicAgentIntent / ' +
        'publicIntentResult / publicTranscriptEntry, or add it to JUSTIFIED_UNPROJECTED with a ' +
        'reason it cannot reach a response',
    ).toEqual([]);
  });

  it('CRITICAL each justified exception still exists, so the list cannot rot', () => {
    const texts = intentSites().map((s) => s.text);
    for (const justified of JUSTIFIED_UNPROJECTED) {
      expect(
        texts,
        `a JUSTIFIED_UNPROJECTED entry no longer matches any site — a stale exemption silently ` +
          `widens what this guard permits: ${justified}`,
      ).toContain(justified);
    }
  });
});
