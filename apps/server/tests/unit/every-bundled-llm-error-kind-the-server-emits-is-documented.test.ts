// Every `kind` the server counts on `driftstack_bundled_llm_error_total` is
// documented in the metrics reference, and every documented kind is one the
// server counts.
//
// The docs page listed two kinds (consent_missing, budget_exhausted) while the
// server emitted five, then six. A kind nobody documented is a series nobody
// alerts on — which is how a model with no price (our fault) sat unwatched inside
// the same counter as a customer choosing Opus (expected).
//
// The emitted set is DERIVED from the source: every
// `inc(METRIC_NAMES.bundledLlmErrorTotal, { kind: … })` label object under
// apps/server/src, comments stripped, every string literal in it (so a ternary
// choosing between two kinds contributes both).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const DOCS = resolve(HERE, '..', '..', '..', 'docs', 'src', 'pages', 'reference', 'metrics.md');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** kind -> the files that emit it. */
function emittedKinds(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of sourceFiles(SRC)) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/METRIC_NAMES\.bundledLlmErrorTotal\s*,\s*\{([^}]*)\}/g)) {
      for (const lit of m[1]!.matchAll(/'([a-z_]+)'/g)) {
        const files = out.get(lit[1]!) ?? new Set<string>();
        files.add(file.slice(file.indexOf('/src/') + 1));
        out.set(lit[1]!, files);
      }
    }
  }
  return out;
}

/** The kinds in the docs page's `kind` table: the rows after its header line. */
function documentedKinds(): string[] {
  const lines = readFileSync(DOCS, 'utf8').split('\n');
  const header = lines.findIndex((l) => /^\|\s*`kind`\s*\|/.test(l));
  if (header === -1) return [];
  const kinds: string[] = [];
  for (const line of lines.slice(header + 2)) {
    const row = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);
    if (row === null) break;
    kinds.push(row[1]!);
  }
  return kinds;
}

describe('every bundled-LLM error kind the server emits is documented', () => {
  it('the scans found real data on both sides — an empty set on either would make the comparisons below pass by comparing nothing', () => {
    const emitted = emittedKinds();
    // Floors that a working scan exceeds and a broken one cannot: the kinds
    // emitted from the route and from the runtime, the two files that count them.
    for (const kind of ['consent_missing', 'budget_exhausted', 'usage_record_persist_failed']) {
      expect(emitted.has(kind), `a known kind must survive the scan: ${kind}`).toBe(true);
    }
    expect(emitted.size).toBeGreaterThanOrEqual(7);
    expect(documentedKinds().length).toBeGreaterThanOrEqual(7);
  });

  it('CRITICAL the customer choosing Opus and a model with no price are separate kinds, both emitted', () => {
    const emitted = emittedKinds();
    expect(emitted.has('model_requires_own_key')).toBe(true);
    expect(emitted.has('model_unpriced')).toBe(true);
  });

  it('CRITICAL every emitted kind is documented in the metrics reference', () => {
    const documented = new Set(documentedKinds());
    const missing = [...emittedKinds()]
      .filter(([kind]) => !documented.has(kind))
      .map(([kind, files]) => `${kind} (emitted in ${[...files].join(', ')})`)
      .sort();
    expect(missing, 'kind(s) the server counts that the docs do not explain:').toEqual([]);
  });

  it('every documented kind is one the server emits — a documented kind nothing counts is an alert that can never fire', () => {
    const emitted = emittedKinds();
    const stale = documentedKinds().filter((kind) => !emitted.has(kind));
    expect(stale, 'kind(s) documented but never counted:').toEqual([]);
  });
});
