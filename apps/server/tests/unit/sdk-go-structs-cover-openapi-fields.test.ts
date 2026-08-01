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

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const GO_DIR = resolve(REPO, 'packages', 'sdk-go');
const SPEC = resolve(REPO, 'packages', 'sdk-python', 'openapi.json');

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
      if (!structs.has(name)) continue;
      const have = allFields(name, structs);
      // Query/request types use `url:` tags rather than `json:`; a struct with
      // no json tags at all is not a response shape and is not this guard's
      // business.
      if (have.size === 0) continue;
      const gap = [...props].filter((p) => !have.has(p));
      if (gap.length > 0) missing.push(`${name}: ${gap.sort().join(', ')}`);
    }
    expect(
      missing.sort(),
      'Go struct(s) missing fields the API returns — the caller cannot read them:',
    ).toEqual([]);
  });
});
