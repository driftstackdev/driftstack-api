// A hand-written Go struct must not silently drop fields the API returns.
//
// The Python SDK's models are GENERATED from the OpenAPI document, so they
// cannot drift. The TypeScript and Go types are hand-written. TypeScript stayed
// in sync; Go did not: `AgentSession` was missing `capability_report` and
// `error_event`, both of which the API returns and both of which the other two
// SDKs expose.
//
// That is not cosmetic. `error_event` carries `severity`, `customer_actionable`
// and `retryable` — the three facts a caller uses to decide whether to surface a
// failure to a human or just try again. A Go caller could read `status:
// "closed"` and had no way to learn why, how badly, or whether a retry was
// worth attempting. The field was simply absent from the struct, so
// `encoding/json` discarded it on decode without erroring.
//
// This is the same shape as the `?keep=current` bug: an ABSENCE. A content-parity
// pin can only check what the source says, never what it fails to say, so
// nothing in the repo could have caught either one.
//
// EMBEDDING IS RESOLVED, and that is the whole difficulty. A first pass without
// it reported four offenders and three were false: `CreateWebhookResponse`
// embeds `WebhookEndpoint`, `RecipeDetail` embeds `Recipe`, and
// `ListDeliveriesQuery` is a query type using `url:` tags rather than `json:`.
// A guard that cries wolf three times out of four gets switched off, so the
// parser follows embedded types before deciding anything is missing.
//
// WHAT THIS GUARD CANNOT SEE, stated because a scan's reach is an assumption
// until it is written down. It compares TOP-LEVEL fields of a shape whose NAME
// matches a spec schema. Fields nested inside an INLINE object literal are
// invisible: removing `egress_state` from the TypeScript AgentSession's inline
// `capability_report` object leaves this green, and that was measured, not
// assumed. Go is less exposed because its nested shapes are named structs, which
// do get compared. Extending to inline objects means resolving anonymous types
// against nested schemas, which is worth doing when a bug appears there — not
// speculatively, since the parser complexity is where false alarms come from.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const GO_DIR = resolve(REPO, 'packages', 'sdk-go');
const SPEC = resolve(REPO, 'packages', 'sdk-python', 'openapi.json');
const TS_DIR = resolve(REPO, 'packages', 'sdk-typescript', 'src');

interface GoStruct {
  /** json tag names declared directly on this struct. */
  readonly own: Set<string>;
  /** Names of embedded structs, whose fields are also part of the shape. */
  readonly embeds: string[];
}

function goStructs(): Map<string, GoStruct> {
  const out = new Map<string, GoStruct>();
  for (const entry of readdirSync(GO_DIR)) {
    if (!entry.endsWith('.go') || entry.endsWith('_test.go')) continue;
    const src = readFileSync(resolve(GO_DIR, entry), 'utf8');
    for (const m of src.matchAll(/type (\w+) struct \{([\s\S]*?)\n\}/g)) {
      const own = new Set<string>();
      const embeds: string[] = [];
      for (const raw of m[2]!.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('//')) continue;
        const tag = /`json:"([^",]+)/.exec(line);
        if (tag !== null) {
          own.add(tag[1]!);
          continue;
        }
        // An embedded type is a bare identifier on its own line.
        const embed = /^(\*?)([A-Z]\w*)$/.exec(line);
        if (embed !== null) embeds.push(embed[2]!);
      }
      out.set(m[1]!, { own, embeds });
    }
  }
  return out;
}

/** Every json tag in a struct, following embedded types. */
function allFields(
  name: string,
  table: Map<string, GoStruct>,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const s = table.get(name);
  if (s === undefined) return new Set();
  const out = new Set(s.own);
  for (const e of s.embeds) for (const f of allFields(e, table, seen)) out.add(f);
  return out;
}

interface TsInterface {
  readonly own: Set<string>;
  /** Interfaces this one extends; their fields are part of the shape too. */
  readonly extends: string[];
}

/**
 * TypeScript interfaces declared in the SDK.
 *
 * Far fewer of these name-match a spec schema than on the Go side, because the
 * TypeScript SDK imports most shapes from `@driftstack/api-types` — and those
 * are the very definitions the OpenAPI document is generated from, so they
 * cannot drift. What is left is the hand-written remainder, which can.
 */
function tsInterfaces(): Map<string, TsInterface> {
  const out = new Map<string, TsInterface>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(
          /export interface (\w+)(?: extends ([\w, ]+))? \{([\s\S]*?)\n\}/g,
        )) {
          out.set(m[1]!, {
            own: new Set([...m[3]!.matchAll(/^\s*(\w+)\??:/gm)].map((f) => f[1]!)),
            extends: (m[2] ?? '')
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x !== ''),
          });
        }
      }
    }
  };
  walk(TS_DIR);
  return out;
}

/** Every field on a TS interface, following `extends`. */
function allTsFields(
  name: string,
  table: Map<string, TsInterface>,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const i = table.get(name);
  if (i === undefined) return new Set();
  const out = new Set(i.own);
  for (const e of i.extends) for (const f of allTsFields(e, table, seen)) out.add(f);
  return out;
}

/**
 * Can this interface's full shape be reconstructed from SDK source alone?
 *
 * `RotateApiKeyResponse extends CreateApiKeyResponse`, and that parent is
 * IMPORTED from `@driftstack/api-types` rather than declared here — so its
 * fields are invisible to this parser and the interface reads as missing all
 * nine of them. That is a false alarm, and this file's header is explicit that
 * a guard which cries wolf gets switched off rather than fixed.
 *
 * Such interfaces are skipped, but the skip is COUNTED and pinned below, so the
 * blind spot cannot quietly grow.
 */
function tsResolvable(
  name: string,
  table: Map<string, TsInterface>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(name)) return true;
  seen.add(name);
  const i = table.get(name);
  if (i === undefined) return false;
  return i.extends.every((e) => tsResolvable(e, table, seen));
}

/** OpenAPI component schemas that describe an object, name → property names. */
function specSchemas(): Map<string, Set<string>> {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
  };
  const out = new Map<string, Set<string>>();
  for (const [name, s] of Object.entries(spec.components?.schemas ?? {})) {
    if (s.properties !== undefined) out.set(name, new Set(Object.keys(s.properties)));
  }
  return out;
}

/**
 * V-1506 — spec schemas the TypeScript SDK models under a different NAME.
 *
 * These are NOT the imported-from-api-types shapes the docstring above rightly
 * excludes — every interface below is declared in the SDK itself, so it is the
 * hand-written remainder that can drift. It escaped comparison only because the
 * SDK names types for the people calling it rather than after the wire schema:
 * `AccountMeResponse` is `AccountSelfProfile`, `AgentMessageUsage` is `AgentUsage`.
 * Each pair was checked field-by-field before being listed and none was missing
 * anything — coverage the guard did not have, not a repair of something broken.
 *
 * Listed by hand because a heuristic pairing is worse than none: matching on field
 * overlap pairs any two shapes that happen to agree, and a wrong pair reports
 * confident nonsense. The arm above asserts every entry still resolves, so an
 * alias that rots stops the run instead of quietly comparing nothing.
 */
/**
 * V-1506b — the Go SDK's name for a schema, when it differs only by initialism.
 *
 * golint requires `APIKey`, not `ApiKey`, so `CreateApiKeyRequest` is
 * `CreateAPIKeyRequest` on the Go side and the name key skipped every one of
 * them. This is a RULE rather than a list because the difference is mechanical:
 * a new `…ApiKey…` schema is covered the day it lands, where a hand-written
 * entry would have to be remembered.
 *
 * Deliberately narrow. It only resolves a name the rule TRANSFORMS and which
 * exists as a struct — it never guesses at a pairing, so a schema the Go SDK
 * genuinely does not model stays uncompared rather than being matched to
 * whatever is nearby.
 */
function goInitialismName(schema: string): string {
  return schema
    .replace(/Api/g, 'API')
    .replace(/Url/g, 'URL')
    .replace(/\bId\b/g, 'ID');
}

const TS_ALIASES: ReadonlyArray<readonly [schema: string, iface: string]> = [
  ['AccountMeResponse', 'AccountSelfProfile'],
  ['AccountAuditEntry', 'AuditLogEntry'],
  ['ExportAccountAuditResponse', 'AuditLogExportResponse'],
  ['AgentMessageUsage', 'AgentUsage'],
  ['ByokAnthropicMetadata', 'ByokAnthropicKeyMetadata'],
];

describe('sdk-go structs cover the fields the API returns', () => {
  it('CRITICAL both sides parsed. The check below reports an absence, so an empty parse on either side would report perfect coverage — the exact failure this guard exists to catch, wearing the guard as a disguise.', () => {
    const structs = goStructs();
    const spec = specSchemas();
    expect(structs.size, 'Go structs parsed').toBeGreaterThan(100);
    expect(spec.size, 'OpenAPI object schemas parsed').toBeGreaterThan(50);
    expect(structs.has('AgentSession'), 'a known struct survived the parse').toBe(true);
  });

  it('CRITICAL embedding is resolved. Without it, CreateWebhookResponse looks like it is missing fourteen fields it inherits from WebhookEndpoint — and a guard that is wrong three times out of four gets switched off rather than fixed.', () => {
    const structs = goStructs();
    const fields = allFields('CreateWebhookResponse', structs);
    expect(
      structs.get('CreateWebhookResponse')?.own.has('url'),
      'url is NOT declared directly on the response type',
    ).toBe(false);
    expect(fields.has('url'), 'but it IS part of the shape, via the embedded endpoint').toBe(true);
    expect(fields.has('secret'), 'alongside the fields the response adds itself').toBe(true);
  });

  it('CRITICAL no Go struct drops a field its matching OpenAPI schema declares. encoding/json discards unknown keys silently, so a missing field is not a decode error — it is data the caller can never see. AgentSession dropped error_event, which carries severity, customer_actionable and retryable.', () => {
    const structs = goStructs();
    const missing: string[] = [];
    for (const [name, props] of specSchemas()) {
      // V-1506b — fall back to the initialism spelling before giving up.
      const goName = structs.has(name) ? name : goInitialismName(name);
      if (!structs.has(goName)) continue;
      const have = allFields(goName, structs);
      // Query/request types use `url:` tags rather than `json:`; a struct with
      // no json tags at all is not a response shape and is not this guard's
      // business.
      if (have.size === 0) continue;
      const gap = [...props].filter((p) => !have.has(p));
      if (gap.length > 0) {
        missing.push(
          `${name}${goName === name ? '' : ` (as ${goName})`}: ${gap.sort().join(', ')}`,
        );
      }
    }
    expect(
      missing.sort(),
      'Go struct(s) missing fields the API returns — the caller cannot read them:',
    ).toEqual([]);
  });
  it('CRITICAL the TypeScript parse found interfaces too. Same reasoning as the Go arm: this reports an absence, so an empty parse would report perfect coverage.', () => {
    const ifaces = tsInterfaces();
    expect(ifaces.size, 'TS interfaces parsed').toBeGreaterThan(30);
    const matched = [...specSchemas().keys()].filter((n) => ifaces.has(n));
    expect(matched.length, 'TS interfaces name-matching a spec schema').toBeGreaterThanOrEqual(9);
  });

  it('CRITICAL `extends` is resolved for TypeScript, the analogue of Go embedding. Without it an interface that inherits its fields reads as missing all of them, which is how a guard earns a reputation for false alarms.', () => {
    const ifaces = tsInterfaces();
    const extending = [...ifaces.entries()].filter(([, i]) => i.extends.length > 0);
    expect(extending.length, 'interfaces using extends').toBeGreaterThan(0);
    const [name, iface] = extending[0]!;
    const parent = iface.extends[0]!;
    const parentFields = allTsFields(parent, ifaces);
    if (parentFields.size > 0) {
      const inherited = [...parentFields][0]!;
      expect(iface.own.has(inherited), `${inherited} is not declared directly on ${name}`).toBe(
        false,
      );
      expect(
        allTsFields(name, ifaces).has(inherited),
        `but it IS part of ${name} via extends ${parent}`,
      ).toBe(true);
    }
  });

  it('V-1506 CRITICAL the reach is a measured number, and the five hand-written shapes the name key missed are compared. The low TypeScript count is already EXPLAINED by this file — most SDK shapes are imported from api-types, which is what the document is generated from, so they cannot drift. What the file never states is the number: 11 of 70 on the TypeScript side, 39 on the Go side, 30 compared by neither. The gap this closes is narrower and real — types the SDK declares ITSELF, which the docstring calls the hand-written remainder that CAN drift, and which escaped comparison only because the SDK names them for its callers rather than after the wire schema: AccountMeResponse is AccountSelfProfile, AgentMessageUsage is AgentUsage. Each was verified field-by-field and none was missing anything, so this is reach rather than repair.', () => {
    const ifaces = tsInterfaces();
    const structs = goStructs();
    const schemas = specSchemas();
    const tsMatched = [...schemas.keys()].filter((n) => ifaces.has(n));
    const goMatched = [...schemas.keys()].filter((n) => structs.has(n));
    const aliased = TS_ALIASES.filter(
      ([schema, iface]) => schemas.has(schema) && ifaces.has(iface),
    );

    expect(schemas.size, 'spec schemas carrying properties').toBeGreaterThanOrEqual(70);
    expect(tsMatched.length, 'spec schemas a TypeScript interface shares a name with').toBe(11);
    expect(goMatched.length, 'spec schemas a Go struct shares a name with').toBeGreaterThanOrEqual(
      39,
    );
    // Every alias must still resolve on BOTH sides. An alias whose interface was
    // renamed again silently stops comparing anything, which is the failure this
    // whole arm exists to make loud.
    expect(aliased.length, 'declared aliases that still resolve to a real pair').toBe(
      TS_ALIASES.length,
    );
  });

  it('CRITICAL no TypeScript interface drops a field its matching OpenAPI schema declares. The Go side of this guard exists because AgentSession dropped error_event; the TypeScript types are hand-written too and can drift the same way.', () => {
    const ifaces = tsInterfaces();
    const missing: string[] = [];
    const unresolvable: string[] = [];
    // V-1506 — the aliased pairs are judged by exactly the same rule as the
    // name-matched ones. Each was verified field-by-field before being listed;
    // none was missing anything, so this is reach rather than a repair.
    for (const [schema, iface] of TS_ALIASES) {
      const props = specSchemas().get(schema);
      if (props === undefined || !ifaces.has(iface)) continue;
      const have = allTsFields(iface, ifaces);
      const gap = [...props].filter((p) => !have.has(p));
      if (gap.length > 0) missing.push(`${schema} (as ${iface}): ${gap.sort().join(', ')}`);
    }
    for (const [name, props] of specSchemas()) {
      if (!ifaces.has(name)) continue;
      // A parent living in api-types cannot be reconstructed here; counted
      // rather than reported as missing everything it inherits.
      if (!tsResolvable(name, ifaces)) {
        unresolvable.push(name);
        continue;
      }
      const have = allTsFields(name, ifaces);
      if (have.size === 0) continue;
      const gap = [...props].filter((p) => !have.has(p));
      if (gap.length > 0) missing.push(`${name}: ${gap.sort().join(', ')}`);
    }
    expect(missing.sort(), 'TypeScript interface(s) missing fields the API returns:').toEqual([]);
    // Bound what this guard admits it cannot see. One today, whose parent is
    // imported. If this list grows, the blind spot is growing with it and
    // wants a look — not a bigger expected array.
    expect(
      unresolvable.sort(),
      'interface(s) whose parent is declared outside the SDK, so coverage is unverifiable:',
    ).toEqual(['RotateApiKeyResponse']);
  });
});
