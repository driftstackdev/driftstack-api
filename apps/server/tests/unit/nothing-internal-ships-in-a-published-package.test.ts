// Nothing internal ships in a published package.
//
// Four artifacts carry our text to people who are not us: npm `@driftstack/sdk`,
// npm `@driftstack/api-types`, the PyPI wheel + sdist, and the Go module at its
// tag. The owner's rule for that text is that it says WHAT the product does,
// never HOW it is built inside. Against published baselines of ZERO, the
// prepared 0.2.0 / 0.2.0 / v0.3.0 release carries internal ticket ids and
// internal infrastructure vocabulary in all four — including 144 ids in the
// `.d.ts` pair, which is the text a customer's editor shows on hover, and the
// full TypeScript source, which ships as `sourcesContent` inside `dist/*.map`.
//
// THIS IS A RATCHET, NOT AN ASSERTION OF ZERO — yet. Four package lanes lower
// these counts; this runs BEFORE them, so demanding zero today would be a red
// gate nobody can act on and everybody learns to ignore. Instead:
//
//   · a count may not RISE — nothing new leaks while the sweep is in flight;
//   · a count that has reached zero may not still be listed as non-zero — the
//     ratchet is trimmed in the same change that lowers it, so it cannot drift
//     into fiction;
//   · when the ratchet file is gone, every count must be zero. That is the end
//     state, and deleting the file is how a lane declares it.
//
// AND IT MUST NOT PASS BY READING NOTHING. A scan over a `dist/` that was never
// built reports zero and looks exactly like success. So the ratchet also records
// how many shipped TEXT files the scan opened, and this fails if that number
// falls.
//
// HOW THE FILE LISTS ARE BUILT HERE, and why not the way the script does it by
// default. The script prefers `npm pack --dry-run --json` and a real
// `python -m build`. CI's `build-test` job installs the Python venv with
// `.[dev]`, which does NOT include `build`, so a Python build is not available
// there — and a guard whose numbers depend on which tools a machine happens to
// have is a guard with two baselines. This pins the DERIVED method for both
// ecosystems, which needs nothing but the repository, and then measures the
// derived npm list against `npm pack` in its own arm. Go uses `git ls-files`,
// which CI has (`actions/checkout` with fetch-depth 50).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  ALLOW_LIST,
  BLIND_SPOTS,
  INTERNAL_VOCABULARY,
  PACKAGES,
  RULES,
  TICKET_ID,
  npmShippedFilesDerived,
  npmShippedFilesViaPack,
  scanPackages,
  scanText,
} from '../../../../scripts/scan-shipped-text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const RATCHET_PATH = resolve(HERE, 'nothing-internal-ships-in-a-published-package.ratchet.json');

/** The same options in every arm, so every number below is the same measurement. */
const OPTIONS = { npmMethod: 'derived', pythonMethod: 'derived', goTests: false } as const;

interface RatchetEntry {
  files: number;
  textFiles: number;
  'ticket-id': number;
  'internal-vocabulary': number;
}

/**
 * Whether the ratchet file is on disk — read as DATA, deliberately, and not as
 * `if (!existsSync(…)) return` inside an arm.
 *
 * This is the one subject here whose ABSENCE is meaningful rather than broken:
 * deleting the file is how a lane declares the sweep finished, and the third arm
 * below then demands zero on every axis. Both branches assert something, so
 * nothing is skipped either way — which is why this is not the silent swallow
 * that `a-walk-that-swallows-a-missing-root-does-not-spread` holds to zero.
 * Every OTHER subject (the packages, their dists) is required to exist: the scan
 * fails loudly if a package directory is missing, and the text-file floor below
 * catches a dist that was never built.
 */
const RATCHET_EXISTS = existsSync(RATCHET_PATH);

function readRatchet(): Record<string, Record<string, RatchetEntry>> | null {
  if (!RATCHET_EXISTS) return null;
  const parsed = JSON.parse(readFileSync(RATCHET_PATH, 'utf8')) as {
    packages: Record<string, Record<string, RatchetEntry>>;
  };
  return parsed.packages;
}

const results = scanPackages(REPO_ROOT, PACKAGES, OPTIONS);
const ratchet = readRatchet();

/** One measured artifact, flattened so the verdict below can be a pure function. */
interface Measured {
  package: string;
  artifact: string;
  textFiles: number;
  'ticket-id': number;
  'internal-vocabulary': number;
}

interface Verdict {
  /** A count that GREW — new internal text reached a published artifact. */
  risen: string[];
  /** A count that is zero while the ratchet still allows more than zero. */
  stale: string[];
  /** Fewer shipped text files were opened than the ratchet recorded. */
  shrunk: string[];
  /** The ratchet file is gone and something internal is still there. */
  mustBeZero: string[];
}

/**
 * The whole comparison, as a pure function.
 *
 * Every arm below says some number did not get worse, and four arms that all
 * report "nothing got worse" cannot tell a working comparison from one that
 * returns an empty list for everything. Keeping the logic here lets the last arm
 * drive it from fixtures and watch each verdict fire.
 */
function ratchetVerdict(
  measured: readonly Measured[],
  recorded: Record<string, Record<string, RatchetEntry>> | null,
): Verdict {
  const v: Verdict = { risen: [], stale: [], shrunk: [], mustBeZero: [] };
  for (const m of measured) {
    const entry = recorded?.[m.package]?.[m.artifact];
    for (const cls of [TICKET_ID, INTERNAL_VOCABULARY] as const) {
      const now = m[cls];
      const allowed = entry?.[cls] ?? 0;
      if (now > allowed)
        v.risen.push(
          `${m.package} \u00b7 ${m.artifact} \u00b7 ${cls}: ${String(allowed)} \u2192 ${String(now)}. ` +
            `Run \`node scripts/scan-shipped-text.mjs --package ${m.package}\` to see where.`,
        );
      if (entry !== undefined && now === 0 && entry[cls] !== 0)
        v.stale.push(
          `${m.package} \u00b7 ${m.artifact} \u00b7 ${cls} is now 0 but the ratchet says ` +
            `${String(entry[cls])}. Set it to 0, and delete the artifact entry once both classes ` +
            `are 0 \u2014 the file itself goes when every artifact is clean.`,
        );
      if (recorded === null && now !== 0)
        v.mustBeZero.push(`${m.package} \u00b7 ${m.artifact} \u00b7 ${cls}: ${String(now)}`);
    }
    if (entry !== undefined && m.textFiles < entry.textFiles)
      v.shrunk.push(
        `${m.package} \u00b7 ${m.artifact}: read ${String(m.textFiles)} text files, ratchet ` +
          `recorded ${String(entry.textFiles)}. For the npm packages this usually means dist/ was ` +
          `never built (\`npm run build -w packages/${m.package}\`); an empty scan reports zero ` +
          `and reads exactly like a clean package.`,
      );
  }
  return v;
}

const measured: Measured[] = results.flatMap((pkg) =>
  pkg.artifacts.map((a) => ({
    package: pkg.package,
    artifact: a.artifact,
    textFiles: a.textFileCount,
    [TICKET_ID]: a.counts[TICKET_ID],
    [INTERNAL_VOCABULARY]: a.counts[INTERNAL_VOCABULARY],
  })),
);
const verdict = ratchetVerdict(measured, ratchet);

describe('nothing internal ships in a published package', () => {
  it('CRITICAL no package carries MORE internal text than the ratchet records', () => {
    expect(
      verdict.risen,
      `internal text that ships GREW. Customer-facing text says what the product does, ` +
        `never how it is built inside:\n  ${verdict.risen.join('\n  ')}`,
    ).toEqual([]);
  });

  it('CRITICAL a count that has reached zero is not still listed as non-zero in the ratchet', () => {
    expect(
      verdict.stale,
      `the ratchet is behind the tree. A stale allowance is a gate that permits what has ` +
        `already been fixed:\n  ${verdict.stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('CRITICAL with no ratchet file, every package ships zero internal ids and zero internal vocabulary', () => {
    // Which mode ran is recorded rather than left to be inferred from a pass.
    expect(RATCHET_EXISTS ? 'ratchet' : 'zero').toBe(ratchet === null ? 'zero' : 'ratchet');
    expect(
      verdict.mustBeZero,
      `the ratchet is gone, so these must be gone too:\n  ${verdict.mustBeZero.join('\n  ')}\n` +
        `Run \`node scripts/scan-shipped-text.mjs\` for the file:line of each.`,
    ).toEqual([]);
  });

  it('the scan opened at least as many shipped text files as the ratchet recorded, so a missing build cannot read as a clean sweep', () => {
    expect(verdict.shrunk, verdict.shrunk.join('\n  ')).toEqual([]);
  });

  it('NEGATIVE CONTROL every ratchet verdict fires on a measurement built to trigger it', () => {
    const entry = { files: 2, textFiles: 2, [TICKET_ID]: 5, [INTERNAL_VOCABULARY]: 1 };
    const book = { p: { a: entry } };
    const at = (ticket: number, vocab: number, textFiles = 2): Measured[] => [
      { package: 'p', artifact: 'a', textFiles, [TICKET_ID]: ticket, [INTERNAL_VOCABULARY]: vocab },
    ];

    // Unchanged, and lowered, are both clean.
    expect(ratchetVerdict(at(5, 1), book)).toEqual({
      risen: [],
      stale: [],
      shrunk: [],
      mustBeZero: [],
    });
    expect(ratchetVerdict(at(2, 1), book).risen).toEqual([]);

    // One more id than the ratchet allows.
    expect(ratchetVerdict(at(6, 1), book).risen).toHaveLength(1);
    expect(ratchetVerdict(at(6, 1), book).risen[0]).toMatch(/ticket-id: 5 → 6/);

    // Finished, but the ratchet still allows five.
    expect(ratchetVerdict(at(0, 1), book).stale).toHaveLength(1);
    expect(ratchetVerdict(at(0, 0), book).stale).toHaveLength(2);

    // Fewer files read than were read when the ratchet was written.
    expect(ratchetVerdict(at(5, 1, 1), book).shrunk).toHaveLength(1);

    // No ratchet at all: anything left over is a failure, and zero is a pass.
    expect(ratchetVerdict(at(5, 1), null).mustBeZero).toHaveLength(2);
    expect(ratchetVerdict(at(0, 0), null).mustBeZero).toEqual([]);
    expect(ratchetVerdict(at(0, 0), null).risen).toEqual([]);
  });

  it('every package in the roster produced at least one artifact with files in it', () => {
    for (const pkg of results) {
      expect(pkg.artifacts.length, `${pkg.package} produced no artifact`).toBeGreaterThan(0);
      for (const a of pkg.artifacts)
        expect(
          a.fileCount,
          `${pkg.package} · ${a.artifact} shipped-file list is empty`,
        ).toBeGreaterThan(0);
    }
    expect(results.map((r) => r.package)).toEqual([...PACKAGES]);
  });

  it('CRITICAL the derived npm file list is the list npm would pack, so the scan is not measuring a narrower set than ships', () => {
    for (const pkg of ['sdk-typescript', 'api-types']) {
      const dir = resolve(REPO_ROOT, 'packages', pkg);
      const packed = npmShippedFilesViaPack(dir);
      expect(
        packed,
        `\`npm pack --dry-run --json\` produced nothing for ${pkg}. This arm is the only thing ` +
          `checking that the derived list is complete; it does not get to abstain.`,
      ).not.toBeNull();
      expect(
        npmShippedFilesDerived(dir),
        `${pkg}: derived file list differs from npm pack`,
      ).toEqual(packed);
    }
    // 60s, not vitest's 10s default. This arm spawns `npm pack --dry-run`
    // twice, which costs ~0.8s each on an idle machine and was measured at
    // 3.7s + 4.8s on a loaded one — close enough to 10s that a busy CI runner
    // decides the outcome. It is the ONLY thing checking that the derived list
    // is complete, so a timeout here reads as a broken guard rather than a slow
    // one, and the fix for that is not to make the guard smaller.
  }, 60_000);

  it('names its blind spots rather than reading as total', () => {
    expect(BLIND_SPOTS.length).toBeGreaterThanOrEqual(4);
    expect(BLIND_SPOTS.join('\n')).toMatch(/_test\.go/);
    expect(BLIND_SPOTS.join('\n')).toMatch(/lower-case `node`/);
    // An internal word inside an identifier is the blind spot that a zero on
    // the vocabulary class hides, and the artifacts exercise it today. Naming
    // it is what stops the exit code from reading as "no internal words ship".
    expect(BLIND_SPOTS.join('\n')).toMatch(/inside an identifier/i);
  });

  // The arm above asserts the blind spot is DESCRIBED. This one asserts it is
  // REAL — in both directions, because a sentence in BLIND_SPOTS that no longer
  // matches the scanner's behaviour is worse than no sentence at all: it would
  // go on excusing a class the rules had quietly started catching, or promise a
  // gap that had been closed.
  it('NEGATIVE CONTROL an internal word inside an identifier is invisible while the same word in prose is reported', () => {
    const invisible = [
      'measured_from: Literal["fleet", "control_plane"]',
      '"mac_node.livekit_registered", "mac_node.control"',
      'mac_node_id: UUID',
      'class RegisterMacNodeRequest(BaseModel):',
      'single_host_vantage: z.ZodBoolean; web_port_vantage: z.ZodBoolean;',
      '"vpn_tunnel", "not_observed", "observer_off"',
      'node_busy | node_error | no_node',
    ];
    for (const identifier of invisible)
      expect(scanText(identifier), `the blind spot has closed for ${identifier}`).toEqual([]);

    // Without this half, "reports nothing" is also satisfied by a broken
    // scanner, and the blind spot would read as a rule that works.
    for (const [prose, rule] of [
      ['the device fleet runs it', 'fleet'],
      ['the Mac mini in the rack', 'mac-hardware'],
      ['the observer reported', 'observer'],
    ] as const)
      expect(
        scanText(prose).map((f) => f.rule),
        `${prose} should still report`,
      ).toContain(rule);
  });

  it('every allow-list entry carries a reason and names the rules it applies to', () => {
    for (const entry of ALLOW_LIST) {
      expect(entry.reason.length, `${entry.id} has no reason`).toBeGreaterThan(30);
      const ruleIds = RULES.map((r) => r.id);
      if (entry.rules !== '*')
        for (const r of entry.rules)
          expect(ruleIds, `${entry.id} allows unknown rule ${r}`).toContain(r);
    }
  });

  // ── negative controls ──────────────────────────────────────────────────────
  // Each arm above says a number did not get worse. None of them can tell a
  // working scanner from one that matches nothing, so these two do.

  it('NEGATIVE CONTROL the scanner reports a planted ticket id and a planted infrastructure word', () => {
    const planted = scanText('/** V-312 — the harness on the fleet node. See doc-150 §7. */');
    expect(planted.map((f) => f.rule).sort()).toEqual(
      expect.arrayContaining([
        'harness',
        'fleet',
        'node-as-infrastructure',
        'planning-doc-ref',
        'verdict-id',
      ]),
    );
  });

  it('NEGATIVE CONTROL the scanner reports nothing in ordinary customer-facing copy', () => {
    const clean =
      'Requires Node.js >= 18 and `node:crypto`. Errors follow RFC 7807. Signatures are ' +
      'HMAC-SHA-256 over a UTF-8 body; timestamps are ISO-8601. Version 0.2.0. Works over ' +
      'HTTP/2. Session id 018f3a1c-9b2e-7c41-8a55-1f2b3c4d5e6f on macOS.';
    expect(scanText(clean)).toEqual([]);
  });
});
