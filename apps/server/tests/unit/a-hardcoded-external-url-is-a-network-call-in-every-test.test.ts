import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * V-1611 — a source file that fetches a HARDCODED external URL makes every test
 * reaching it a live network call.
 *
 * ⛔ This is not hypothetical. `updater.test.ts` was doing exactly that against
 * `https://github.com/.../releases/latest/download/latest.json`, and it was
 * INVISIBLE because a malformed fixture threw before the fetch: the deps object
 * omitted `currentVersion`, `checkManifestOnly` calls it inside a `try` whose
 * `catch` returns null, so the TypeError was swallowed and the assertion passed.
 * Supplying the missing field made the test reach GitHub and return the real
 * published version. **A type error was acting as an accidental network guard.**
 *
 * The risk is not the fetch — it is a unit test whose result depends on someone
 * else's uptime and on a release nobody in the test controls.
 */

/** Files allowed to name an external URL, with the reason. Empty means the
 *  next one is a decision someone makes on purpose. */
const ALLOWED = new Map<string, string>([
  [
    'apps/gui-client/src/lib/updater.ts',
    'the release manifest IS an external URL by definition — the updater exists to read GitHub. Its test stubs fetch; see updater.test.ts.',
  ],
]);

const ROOTS = [
  'apps/gui-client/src',
  'apps/server/src',
  'apps/customer-dashboard/src',
  'apps/admin-panel/src',
  'packages',
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === 'tests') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Files whose fetch-like call targets a hardcoded external URL — as a literal,
 * as a same-file const, or as a const composed from one.
 *
 * ⚠️ The composed form is not optional sophistication: the ONE real instance is
 * written `const MANIFEST_URL = `${RELEASES_URL}/download/latest.json``, so a
 * detector that only matched literals would have reported a clean zero while
 * the thing it exists to find sat two lines away. That is the shape M-16
 * records — an instrument blind to exactly the form the known case uses.
 */
function offenders(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(resolve(REPO_ROOT, root))) {
      const t = readFileSync(file, 'utf8');
      const call = /\b(?:fetch|[a-zA-Z]*[Ff]etch)\(\s*([A-Za-z_][\w.]*|['"`]https?:\/\/)/g;
      for (const m of t.matchAll(call)) {
        const tok = m[1] ?? '';
        let external = tok.startsWith("'") || tok.startsWith('"') || tok.startsWith('`');
        if (!external) {
          const direct = new RegExp(`(?:const|let)\\s+${tok}\\s*=\\s*[\`'"]https?://`);
          external = direct.test(t);
          if (!external) {
            const composed = new RegExp(`(?:const|let)\\s+${tok}\\s*=\\s*\`\\$\\{(\\w+)\\}`).exec(
              t,
            );
            if (composed?.[1] !== undefined) {
              external = new RegExp(`(?:const|let)\\s+${composed[1]}\\s*=\\s*[\`'"]https?://`).test(
                t,
              );
            }
          }
        }
        if (external) {
          found.push(
            file
              .slice(REPO_ROOT.length + 1)
              .split(sep)
              .join('/'),
          );
          break;
        }
      }
    }
  }
  return [...new Set(found)].sort();
}

describe('a hardcoded external URL makes every test that reaches it a network call', () => {
  it('CRITICAL the detector can SEE the known instance. Without this arm the roster below could be satisfied by a scanner that finds nothing, which is how a clean zero gets believed.', () => {
    // ⛔ Positive control, first. `updater.ts` is the one real case in the repo
    // and it is written in the composed-const form, so a literal-only matcher
    // returns a reassuring and worthless zero.
    expect(
      offenders(),
      'the detector no longer sees updater.ts — it is broken, not the repo',
    ).toContain('apps/gui-client/src/lib/updater.ts');
  });

  it("CRITICAL no source file outside the roster fetches a hardcoded external URL. A test reaching one depends on somebody else's uptime and on a release nobody in the test controls.", () => {
    const unrostered = offenders().filter((f) => !ALLOWED.has(f));
    expect(
      unrostered,
      'add the file to ALLOWED with the reason it must name an external host, and stub fetch in every test that reaches it',
    ).toEqual([]);
  });

  it('CRITICAL every rostered file still fetches an external URL. A roster entry whose reason has expired is a permanent exemption nobody re-reads.', () => {
    const live = new Set(offenders());
    const stale = [...ALLOWED.keys()].filter((f) => !live.has(f));
    expect(stale, 'these no longer fetch an external URL — drop them from ALLOWED').toEqual([]);
  });
});
