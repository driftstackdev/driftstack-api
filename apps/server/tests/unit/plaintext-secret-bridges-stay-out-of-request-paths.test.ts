// The readers that accept a plaintext secret stay reachable only from migration.
//
// Three encryption modules expose two readers each, and the difference between
// them is the whole security posture:
//
//   readWebhookSecret(...)          STRICT. Throws unless the stored value is a
//                                   v2 envelope. Plaintext and context-free v1
//                                   fail closed. This is the runtime reader.
//   convertWebhookSecretToV2(...)   PERMISSIVE. Accepts canonical plaintext and
//                                   legacy v1, authenticates them, and returns a
//                                   v2 envelope. This is the bootstrap bridge.
//
// The bridge exists because rows written before the envelope format still had to
// be readable once, to be converted. It is correct exactly while it is confined
// to that conversion. Called from a request path it silently restores the
// posture the envelope was introduced to end: a stored plaintext secret would be
// accepted and used to sign outbound webhooks, and nothing would fail.
//
// All three are confined today. Every call site sits inside a method whose name
// says so — `encryptLegacySecrets`, `migrateSecretEnvelopes`,
// `migrateValueEnvelopes` — and the webhook one additionally filters to rows
// that are not yet v2. Nothing keeps it that way. `convertX` reads like an
// ordinary helper at a call site, and the difference between it and the strict
// reader is invisible unless you open the module.
//
// This repo already guards one function-containment invariant the same way:
// `unscoped-lookup-containment-invariant` keeps the two account-unscoped repo
// lookups out of route handlers, on the reasoning that every other guard asserts
// the method EXISTS rather than that it stays unreachable. Same reasoning here,
// for a function whose misuse is quieter.
//
// DERIVED, not listed. The bridges come from scanning the encryption modules for
// exported `convert…` / `migrate…` readers, so a fourth module added next month
// is covered without editing this file. The containment set is likewise derived
// from where they are actually called.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const LIB_DIR = resolve(SERVER_SRC, 'lib');
const ROUTES_DIR = resolve(SERVER_SRC, 'routes');

/** Every .ts under a directory. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = resolve(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'migrations') walk(full);
        continue;
      }
      if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Exported readers in the encryption modules that accept a pre-envelope value.
 * Read from their declarations so a new module's bridge is picked up here.
 */
function plaintextBridges(): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(LIB_DIR)) {
    if (!entry.endsWith('-encryption.ts')) continue;
    const text = readFileSync(resolve(LIB_DIR, entry), 'utf8');
    for (const m of text.matchAll(/export function ((?:convert|migrate)\w*)\s*\(/g)) {
      found.add(m[1]!);
    }
  }
  return [...found].sort();
}

/** Call sites of a bridge outside the module that declares it. */
function bridgeCallSites(): { file: string; line: number; fn: string; method: string }[] {
  const bridges = plaintextBridges();
  const out: { file: string; line: number; fn: string; method: string }[] = [];

  for (const file of tsFilesUnder(SERVER_SRC)) {
    if (file.endsWith('-encryption.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const fn of bridges) {
      for (const m of text.matchAll(new RegExp(`\\b${fn}\\s*\\(`, 'g'))) {
        const before = text.slice(0, m.index);
        const line = before.split('\n').length;
        const enclosing = [...before.matchAll(/async (\w+)\s*\(/g)].pop();
        out.push({
          file: file.slice(SERVER_SRC.length + 1),
          line,
          fn,
          method: enclosing?.[1] ?? '<none>',
        });
      }
    }
  }
  return out;
}

describe('plaintext-accepting secret bridges stay out of request paths', () => {
  it('CRITICAL the bridges were found and are called somewhere. Both assertions below are "none of these is in a route", and a scan that matched no bridge has none in a route — it would report the confinement holding having read no bridge at all.', () => {
    const bridges = plaintextBridges();
    const sites = bridgeCallSites();

    // MEASURED: 3 bridges (webhook, account-proxy, platform-secret-value),
    // 6 call sites across 3 repos.
    expect(bridges.length, 'plaintext-accepting bridges declared').toBeGreaterThanOrEqual(3);
    expect(sites.length, 'call sites found for them').toBeGreaterThanOrEqual(5);
    expect(bridges, 'including the webhook signing-secret one').toContain(
      'convertWebhookSecretToV2',
    );
  });

  it('CRITICAL no route handler calls a plaintext-accepting bridge. The strict reader throws on anything that is not a v2 envelope; the bridge accepts stored plaintext and authenticates it. Reaching for the wrong one by autocomplete would let a plaintext secret sign outbound webhooks, and every existing test would stay green because they assert the bridge WORKS, not that it stays unreachable.', () => {
    const routes = new Set(tsFilesUnder(ROUTES_DIR).map((f) => f.slice(SERVER_SRC.length + 1)));
    const offenders = bridgeCallSites()
      .filter((s) => routes.has(s.file))
      .map((s) => `${s.file}:${String(s.line)} calls ${s.fn}`)
      .sort();
    expect(offenders, 'route handler(s) calling a plaintext-accepting bridge:').toEqual([]);
  });

  it('CRITICAL every bridge call sits in a method that names itself a conversion. Confinement to the repo layer is not enough on its own — a bridge called from an ordinary read method would be just as wrong there, and the method name is what tells a reviewer this path is the one-time migration rather than the hot path.', () => {
    const misplaced = bridgeCallSites()
      .filter((s) => !/^(convert|migrate|encryptLegacy)/i.test(s.method))
      .map((s) => `${s.file}:${String(s.line)} calls ${s.fn} inside ${s.method}()`)
      .sort();
    expect(misplaced, 'bridge call(s) outside a conversion-named method:').toEqual([]);
  });

  it('CRITICAL each module still offers a STRICT reader beside its bridge. The bridge is only defensible because an ordinary caller has a fail-closed alternative; a module that lost its strict reader would leave the permissive one as the only way to read that secret.', () => {
    const missing: string[] = [];
    for (const entry of readdirSync(LIB_DIR)) {
      if (!entry.endsWith('-encryption.ts')) continue;
      const text = readFileSync(resolve(LIB_DIR, entry), 'utf8');
      const hasBridge = /export function (?:convert|migrate)\w*\s*\(/.test(text);
      if (!hasBridge) continue;
      const hasStrict = /export function (?:read|decrypt)\w*\s*\(/.test(text);
      if (!hasStrict) missing.push(entry);
    }
    expect(missing.sort(), 'module(s) with a bridge and no strict reader:').toEqual([]);
  });
});
