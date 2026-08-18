// V-815 — every wire key an SDK reads off a problem body must be one the server
// actually puts there.
//
// All three SDKs exposed a `record_type` / `recordType` / `RecordType` accessor
// on the tier-limit error and read it from `problem["record_type"]`. The server
// has never sent that key. It exists as a `usage_records` COLUMN name, and in a
// hand-written Go SDK test fixture — which is why the Go SDK's own tests passed:
// the fixture supplied the key the production server does not.
//
// So the accessor was empty on every tier-limit error the API can produce. The
// server sends `{ current, limit, resource, tier }` at all twelve
// `new TierLimitError(...)` sites; `resource` is the one carrying "profile".
//
// The damage was customer-facing, and pinned. `packages/sdk-python/examples/
// error_handling.py` prints `monthly quota for {e.record_type} exhausted`, and
// `apps/docs/src/pages/sdk/error-handling.md` shows the same in two languages —
// all rendering an empty value. A content-parity pin froze the field name with
// the title "Drift to a different field name would break SDK consumer
// error-handling logic", which was true, and missed that the name had never
// matched the wire in the first place. Both sides agreed; neither matched the
// server.
//
// A CONTENT PIN CANNOT SEE THIS. It compares an SDK against its own text. This
// compares the SDK against the PRODUCER — the keys are read out of the server's
// throw sites, so adding an extension or renaming one moves the expectation.
//
// The accessors keep their published names. `record_type` ships in 0.1.x of all
// three SDKs and renaming a public field for a spelling would break consumers
// for no functional gain; the fix is to read the right key into it, and to keep
// the old key as a declared fallback.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

/**
 * Keys an SDK may read that the server does not send, with the reason. An entry
 * is a statement that somebody checked it, not that checking is inconvenient.
 */
const LEGACY_FALLBACK_KEYS: Record<string, string> = {
  record_type:
    'V-815 — read as the PRIMARY key until it was checked against the producer, and never ' +
    'sent by any server throw site. Kept as a fallback so a future producer that does send ' +
    'it still populates the accessor, and because the public field name derives from it.',
};

/** Union of extension keys passed to `new <cls>(...)` across the server. */
function serverExtensionKeys(cls: string): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'migrations') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const src = readFileSync(full, 'utf8');
      const needle = `new ${cls}(`;
      let at = src.indexOf(needle);
      while (at !== -1) {
        // Brace-match the call's argument list.
        let depth = 0;
        let end = src.length;
        for (let k = at + needle.length - 1; k < src.length; k += 1) {
          if (src[k] === '(') depth += 1;
          else if (src[k] === ')') {
            depth -= 1;
            if (depth === 0) {
              end = k;
              break;
            }
          }
        }
        const args = src.slice(at + needle.length, end);
        // Skip the first (detail) argument — split at the first TOP-LEVEL comma.
        let d = 0;
        let cut = -1;
        let quote: string | null = null;
        for (let i = 0; i < args.length; i += 1) {
          const ch = args[i] as string;
          if (quote !== null) {
            if (ch === quote && args[i - 1] !== '\\') quote = null;
            continue;
          }
          if (ch === "'" || ch === '"' || ch === '`') quote = ch;
          else if ('([{'.includes(ch)) d += 1;
          else if (')]}'.includes(ch)) d -= 1;
          else if (ch === ',' && d === 0) {
            cut = i;
            break;
          }
        }
        if (cut !== -1) {
          // Lookahead so the delimiter is not consumed — otherwise alternating
          // keys in a shorthand literal are silently dropped, which is a
          // mistake this guard's own author made twice while measuring.
          for (const m of args.slice(cut + 1).matchAll(/(?=[{,]\s*(\w+)\s*[:,}])/g)) {
            keys.add(m[1] as string);
          }
        }
        at = src.indexOf(needle, at + 1);
      }
    }
  };
  walk(SERVER_SRC);
  return keys;
}

/** Wire keys each SDK reads when building its tier-limit error. */
function sdkReadKeys(): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};

  // TypeScript — the TierLimitError constructor.
  const ts = readFileSync(resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts'), 'utf8');
  const tsStart = ts.indexOf('export class TierLimitError');
  const tsBody = ts.slice(tsStart, ts.indexOf('\nexport ', tsStart + 10));
  out.typescript = new Set([...tsBody.matchAll(/\bext\.(\w+)/g)].map((m) => m[1] as string));

  // Python — the QuotaExceededError branch of _error_from_response_data.
  const py = readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/http.py'), 'utf8');
  const pyStart = py.indexOf('if error_cls is QuotaExceededError:');
  const pyBody = py.slice(pyStart, py.indexOf('\n    if error_cls is', pyStart + 10));
  const pyKeys = new Set<string>();
  for (const m of pyBody.matchAll(/problem\.get\("(\w+)"\)/g)) pyKeys.add(m[1] as string);
  for (const m of pyBody.matchAll(/_first_str\(\s*problem\s*,\s*([^)]*)\)/g)) {
    for (const q of (m[1] as string).matchAll(/"(\w+)"/g)) pyKeys.add(q[1] as string);
  }
  out.python = pyKeys;

  // Go — buildQuotaExceeded.
  const go = readFileSync(resolve(REPO_ROOT, 'packages/sdk-go/error_mapping.go'), 'utf8');
  const goStart = go.indexOf('func buildQuotaExceeded');
  const goBody = go.slice(goStart, go.indexOf('\nfunc ', goStart + 10));
  const goKeys = new Set<string>();
  for (const m of goBody.matchAll(/problem\["(\w+)"\]/g)) goKeys.add(m[1] as string);
  for (const m of goBody.matchAll(/\w+FromProblem\(problem,\s*"(\w+)"\)/g)) {
    goKeys.add(m[1] as string);
  }
  out.go = goKeys;

  return out;
}

describe('V-815 an SDK may not read a key the server never sends', () => {
  it('CRITICAL both sides parse real data. Every arm below compares two sets, so an empty producer set or an empty reader set would agree with anything and report health over nothing — the failure mode this family of guards keeps producing.', () => {
    const server = serverExtensionKeys('TierLimitError');
    expect(server.size, 'extension keys read off the server throw sites').toBeGreaterThan(2);
    expect([...server].sort(), 'the tier-limit wire shape').toEqual([
      'current',
      'limit',
      'resource',
      'tier',
    ]);

    const sdks = sdkReadKeys();
    for (const [name, keys] of Object.entries(sdks)) {
      expect(keys.size, `wire keys parsed out of the ${name} builder`).toBeGreaterThan(2);
    }
  });

  it('CRITICAL every SDK reads `resource`, the key that actually carries the capped resource. This is the regression: all three read `record_type` instead, which no server throw site has ever sent, so the accessor was empty on every tier-limit error the API can produce — and a customer-facing example in two languages printed the empty value.', () => {
    const sdks = sdkReadKeys();
    const missing = Object.entries(sdks)
      .filter(([, keys]) => !keys.has('resource'))
      .map(([name]) => name);
    expect(missing, 'these SDKs do not read `resource` from the tier-limit problem body:').toEqual(
      [],
    );
  });

  it('CRITICAL no SDK reads a key the server never sends unless it is a declared legacy fallback. A reader inventing a key is invisible to a content pin, which only ever compares an SDK against its own text — both sides can agree perfectly and neither match the producer.', () => {
    const server = serverExtensionKeys('TierLimitError');
    const sdks = sdkReadKeys();

    const violations: string[] = [];
    for (const [name, keys] of Object.entries(sdks)) {
      for (const key of keys) {
        if (server.has(key)) continue;
        if (LEGACY_FALLBACK_KEYS[key] !== undefined) continue;
        violations.push(`${name} reads "${key}", which no TierLimitError throw site sends`);
      }
    }
    expect(violations, 'SDK reads a wire key the server does not produce:').toEqual([]);
  });

  it('CRITICAL every declared legacy fallback is still genuinely absent from the wire. An allowlist that outlives its reason is how a guard turns into a blindfold — so a key that the server STARTS sending has to come off the list, at which point it is defended like any other.', () => {
    const server = serverExtensionKeys('TierLimitError');
    const nowSent = Object.keys(LEGACY_FALLBACK_KEYS).filter((k) => server.has(k));
    expect(
      nowSent,
      'the server now sends these — delete the fallback entry so the key is checked normally:',
    ).toEqual([]);
  });
});
