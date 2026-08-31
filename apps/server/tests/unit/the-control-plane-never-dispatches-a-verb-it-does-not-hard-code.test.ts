import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HARNESS_INTENT_NAMES } from '../../src/schemas/harness-control-protocol';

/**
 * The harness dispatches on `intent.intentName` with NO allowlist — it runs
 * whatever the control plane sends (A3, 2026-08-31). That makes the CP the only
 * thing standing between a malformed dispatch and execution, and `execute_script`
 * — arbitrary JS in a customer session — is in the declared vocabulary.
 *
 * Today the CP is safe by construction: every emit site is a hard-coded string
 * literal, and `execute_script` has ZERO of them. But "safe by construction" that
 * nothing checks is one refactor from being untrue, and the failure would be
 * silent on this side and unguarded on the other.
 *
 * ⭐ So this pins the ACTUAL emitted set, derived from source. Adding a verb is
 * then a deliberate act that updates this list and re-reads the comment above,
 * rather than something that slips through.
 */

const SRC = resolve(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip comments so prose naming a verb is never mistaken for an emit site. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
}

const files = walk(SRC);
const allCode = files.map((f) => code(readFileSync(f, 'utf8'))).join('\n');

/** Verbs the CP can actually put on the wire. */
const emitted = new Set<string>();
for (const m of allCode.matchAll(/intentName:\s*'([a-z_]+)'/g)) {
  if (m[1] !== undefined) emitted.add(m[1]);
}

/**
 * The nine the CP compiles its documented intents down to. Every one is reached
 * only through `agent-intent-to-dispatch.ts`'s mapping of a customer/agent
 * intent — a customer never names these.
 */
const EXPECTED_EMITTED = [
  'behavioral_pause',
  'click',
  'get_page_source',
  'navigate',
  'press_key',
  'screenshot',
  'scroll',
  'send_keys',
  'wait_for',
].sort();

describe('the control plane never dispatches a harness verb it does not hard-code', () => {
  it('emits exactly the expected set — no more, no fewer', () => {
    expect([...emitted].sort()).toEqual(EXPECTED_EMITTED);
  });

  it('⛔ never emits execute_script — arbitrary JS in a customer session', () => {
    // The single most consequential member of the declared vocabulary. The
    // harness would run it; nothing on that side refuses it.
    expect(emitted.has('execute_script')).toBe(false);
  });

  it.each([
    'back',
    'forward',
    'detect_challenge',
    'extract',
    'perceive',
    'fill_form',
    'search',
    'login',
  ])('declares %s in the transport vocabulary but never emits it', (verb) => {
    // Declared-but-unemitted is FINE — HARNESS_INTENT_NAMES is documented as an
    // internal transport vocabulary, not a customer capability list. Pinned so
    // the gap stays deliberate and readable rather than looking accidental.
    expect(HARNESS_INTENT_NAMES).toContain(verb);
    expect(emitted.has(verb)).toBe(false);
  });

  it('no emit site computes the verb from a value', () => {
    // A literal cannot be steered by a request; an expression can. This is the
    // property that makes the harness's missing allowlist survivable.
    const dynamic = [...allCode.matchAll(/intentName:\s*([^\s,}]+)/g)]
      .map((m) => m[1] ?? '')
      .filter((v) => !v.startsWith("'") && !/^Harness(Intent)?Name/.test(v))
      .filter((v) => !['args.intentName', 'd.intentName'].includes(v));
    expect(dynamic, 'an intentName built from a value could be steered by a request').toEqual([]);
  });

  it('the parse actually found emit sites', () => {
    // Non-vacuity: two silently-empty regexes would make every arm above pass.
    expect(emitted.size).toBeGreaterThanOrEqual(9);
    expect(files.length).toBeGreaterThan(100);
  });
});
