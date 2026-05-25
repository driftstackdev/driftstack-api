// Cross-source invariant: every `client.<resource>.<method>(` call shown in
// the customer docs must reference a real method on the TS SDK.
//
// Closes the bug class fixed in 2f9b8b81: api/billing.md called
// `client.billing.startPortalSession()` and api/billing-crypto.md called
// `client.billing.createCryptoCheckout()`, neither of which exists on the
// SDK (the real names are `createPortalSession` and
// `cryptoOrders.createCheckout`). A customer copy-pasting either hit a
// runtime "x is not a function". The per-page content-parity pins lock
// specific example strings but can themselves encode a wrong name — this
// sweep cross-checks the doc calls against the actual SDK resource classes
// so a non-existent method name can't ship in a customer-facing example.
//
// One-directional on purpose: doc calls must be a SUBSET of SDK methods.
// (The SDK may expose methods the docs don't yet show — that's fine.)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_DIR = resolve(REPO_ROOT, 'apps/docs/src/pages');
const SDK_RES_DIR = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');

function walkDocs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkDocs(p));
    else if (p.endsWith('.md') || p.endsWith('.astro')) out.push(p);
  }
  return out;
}

// SDK resource filenames are kebab-case (crypto-orders.ts); the client
// property they're mounted on is camelCase (client.cryptoOrders).
function fileToClientProp(file: string): string {
  return file.replace(/\.ts$/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// Build the set of `<clientProp>.<method>` pairs the SDK actually exposes.
function buildSdkMethodSet(): Set<string> {
  const methods = new Set<string>();
  for (const file of readdirSync(SDK_RES_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const prop = fileToClientProp(file);
    const src = readFileSync(join(SDK_RES_DIR, file), 'utf8');
    // Class-body members: 2-space-indented `name(` or `async name(` or
    // `name<T>(`. Generous capture — extra entries are harmless (they only
    // widen the allowed set); a MISSED method is what would false-fail, and
    // the resource classes follow this shape uniformly.
    const re = /^ {2}(?:async )?([a-zA-Z][a-zA-Z0-9]*)\s*[(<]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      methods.add(`${prop}.${m[1]}`);
    }
  }
  return methods;
}

describe('docs ↔ TS SDK method-call cross-source invariant', () => {
  const sdkMethods = buildSdkMethodSet();
  const docFiles = walkDocs(DOCS_DIR);

  it('sanity: SDK method set + doc files are non-empty', () => {
    expect(sdkMethods.size).toBeGreaterThan(50);
    expect(docFiles.length).toBeGreaterThan(10);
  });

  it('every client.<resource>.<method>() in the docs exists on the TS SDK', () => {
    // camelCase resource (lowercase first char) → TS example, not Go (PascalCase).
    const callRe = /client\.([a-z][a-zA-Z]*)\.([a-zA-Z][a-zA-Z0-9]*)\(/g;
    const missing: string[] = [];
    for (const file of docFiles) {
      const body = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(body)) !== null) {
        const key = `${m[1]}.${m[2]}`;
        if (!sdkMethods.has(key)) {
          missing.push(`${key}  (${file.slice(REPO_ROOT.length + 1)})`);
        }
      }
    }
    expect(
      missing,
      `doc client.<resource>.<method>() calls with no matching TS SDK method:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
