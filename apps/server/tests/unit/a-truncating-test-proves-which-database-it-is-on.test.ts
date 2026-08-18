// A test that TRUNCATEs must prove which database it is on before it does.
//
// On a file's own database a TRUNCATE is free. Pointed anywhere else it deletes
// whatever every other suite was relying on — and it does so SILENTLY: the run
// stays green, because the rows it destroyed belonged to somebody else, and the
// failure surfaces somewhere unrelated minutes later.
//
// Observed, not imagined. While proving the public-feed test's isolation, a
// mutation that pointed its client back at `DATABASE_URL` truncated the shared
// `incidents` table, deleted the probe row the experiment was measuring, and
// SURVIVED — because it had destroyed the evidence that would have failed it. A
// destructive statement whose blast radius depends on a connection string is the
// one case where "the test passed" says nothing at all.
//
// Two shapes are safe and both are accepted:
//
//   schema-qualified   `TRUNCATE "${TEST_SCHEMA}".incidents` names the target
//                      explicitly, so it cannot reach the shared tables however
//                      the client is configured.
//   proven connection  the file calls `assertIsolatedDatabase(client, NAME)`,
//                      which throws unless `current_database()` matches — or,
//                      in the e2e harness, `assertLocalDestructiveTarget` before
//                      any connection is opened at all, which is the same
//                      property checked earlier and more strictly.
//
// What this rejects is the third shape: a bare `TRUNCATE accounts` in a file
// that merely happens to be pointed at an isolated database today. Four files
// were in exactly that state — including one truncating `accounts`, which
// cascades to most of the schema — all of them correct, none of them proving it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS = resolve(HERE, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** A real TRUNCATE statement, not the word in prose or a CSS class. */
const TRUNCATE_STATEMENT = /`\s*TRUNCATE\b|TRUNCATE TABLE\b|unsafe\(\s*`\s*TRUNCATE\b/;

interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function truncateSites(): Site[] {
  const out: Site[] = [];
  for (const file of walk(TESTS)) {
    const rel = file.slice(TESTS.length + 1);
    // This file quotes the statement it is looking for.
    if (rel.endsWith('a-truncating-test-proves-which-database-it-is-on.test.ts')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i] ?? '';
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
      if (!TRUNCATE_STATEMENT.test(l)) continue;
      // A content-parity pin QUOTES the statement; it does not run one. Matching
      // those reported two doc-pin lines as unproven truncates, which is the
      // over-reporting that gets a guard weakened rather than obeyed.
      if (/expect\(|toMatch\(|\bit\(/.test(l)) continue;
      out.push({ file: rel, line: i + 1, text: l.trim() });
    }
  }
  return out;
}

/** A site is safe when it names a schema, or its file proves the connection. */
function unprovenSites(): string[] {
  const bad: string[] = [];
  for (const site of truncateSites()) {
    if (/\$\{\s*TEST_SCHEMA\s*\}/.test(site.text)) continue;
    const src = readFileSync(resolve(TESTS, site.file), 'utf8');
    if (/assertIsolatedDatabase\s*\(/.test(src)) continue;
    // The e2e harness proves it EARLIER and more strictly — before any
    // connection is opened, because by then real credentials may already point
    // at a real host. A different helper, the same property, better placement.
    if (/assertLocalDestructiveTarget\s*\(/.test(src)) continue;
    bad.push(`${site.file}:${String(site.line)}  ${site.text.slice(0, 70)}`);
  }
  return bad.sort();
}

describe('a truncating test proves which database it is on', () => {
  it('CRITICAL the scan still finds the TRUNCATE statements. Everything here reports an absence, so a pattern that matched nothing would report every truncate proven. The e2e harness and the isolated integration files both have real ones, and they are probed by name.', () => {
    const sites = truncateSites();
    expect(sites.length, 'TRUNCATE statements found in the test tree').toBeGreaterThanOrEqual(6);
    const files = new Set(sites.map((s) => s.file));
    expect([...files], 'the byok migration file truncates accounts — it must be seen').toContain(
      'integration/db-byok-anthropic-envelope-migration-drizzle.test.ts',
    );
    expect([...files], 'the e2e harness truncates too').toContain('e2e/helpers/server.ts');
  });

  it("CRITICAL every TRUNCATE either names a per-file schema or runs on a connection the file has proven. The failure mode is not a red test — it is a green one that deleted another suite's rows, which is why this cannot be left to review. Call assertIsolatedDatabase(client, ISOLATED_DB_NAME) before the first destructive statement, or qualify the target with ${TEST_SCHEMA}.", () => {
    expect(
      unprovenSites(),
      'TRUNCATE(s) whose blast radius depends entirely on a connection string:',
    ).toEqual([]);
  });

  it('CRITICAL the helper it points at exists and throws rather than warns. A soft check here would be worse than none: the caller proceeds to the truncate either way, and the log line lands in a run nobody reads until the damage is somewhere else.', () => {
    const helper = readFileSync(
      resolve(TESTS, 'integration/_helpers/isolated-database.ts'),
      'utf8',
    );
    expect(helper, 'assertIsolatedDatabase is gone').toMatch(
      /export async function assertIsolatedDatabase\(/,
    );
    expect(helper, 'it must compare against current_database()').toMatch(/current_database\(\)/);
    expect(helper, 'it must THROW, not log').toMatch(/throw new Error\(/);
  });
});
