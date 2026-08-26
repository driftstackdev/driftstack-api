// The homepage demo animates the agent's intent vocabulary. This pins it to the
// vocabulary that actually exists.
//
// `AgentPlanDemo.astro` shows seven wire intents as literal JSON, and a customer
// reads them as a description of the product. If a verb is renamed, an enum value
// changes, or the demo gains a step somebody invented to make the animation flow
// better, the page becomes a false claim about the API — and it is the kind of
// false claim nothing else would catch, because a marketing page has no runtime
// and no types.
//
// ⛔ TWO MEMBERS MUST STAY ABSENT, and this is the arm most likely to decay.
// `interact:swipe` and `capture:pdf` are declared in the union and always return
// `{ok:false}` (D-7). They read as perfectly good demo material — swipe is the
// most phone-like gesture there is — so the reason to leave them out lives here
// rather than in someone's memory.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');

const DEMO = resolve(ROOT, 'apps/marketing-site/src/components/AgentPlanDemo.astro');
const SCHEMA = resolve(ROOT, 'packages/api-types/src/agent-intents.ts');

const demo = (): string => readFileSync(DEMO, 'utf-8');
const schema = (): string => readFileSync(SCHEMA, 'utf-8');

/** The `kind` of every intent the demo renders. */
function demoKinds(): string[] {
  return [...demo().matchAll(/"kind":\s*"([a-z_]+)"/g)].map((m) => m[1] ?? '');
}

/**
 * Just the AgentIntentSchema declaration.
 *
 * ⛔ Scoped deliberately. The same file also declares the EXECUTOR RESULT union
 * further down, whose members carry `kind` literals too — reading the whole file
 * returned 9 kinds where the intent union has 6, and would have let the demo
 * advertise a result kind as though it were a verb the agent can be asked for.
 * Caught by the positive control below, which is the only arm that could have.
 */
function intentBlock(): string {
  const text = schema();
  const start = text.indexOf('export const AgentIntentSchema');
  expect(start, 'AgentIntentSchema declaration found').toBeGreaterThan(-1);
  const end = text.indexOf('\n]);', start);
  expect(end, 'AgentIntentSchema terminator found').toBeGreaterThan(start);
  return text.slice(start, end);
}

/** Every `kind` the intent union declares, from its `z.literal(...)` members. */
function schemaKinds(): string[] {
  return [...intentBlock().matchAll(/kind:\s*z\.literal\('([a-z_]+)'\)/g)].map((m) => m[1] ?? '');
}

/** The members of one `z.enum([...])` named by the field that precedes it. */
function schemaEnum(field: string): string[] {
  const re = new RegExp(`${field}:\\s*z\\.enum\\(\\[([^\\]]+)\\]`);
  const body = re.exec(intentBlock())?.[1] ?? '';
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
}

describe('the marketing demo cannot show a verb the API lacks', () => {
  it('CRITICAL POSITIVE CONTROL both sides parse. A zero on either side would make every arm below pass while comparing nothing — which is the failure mode a cross-source guard is FOR.', () => {
    expect(demoKinds().length, 'intents extracted from the demo').toBeGreaterThanOrEqual(5);
    expect(schemaKinds().length, 'kinds extracted from AgentIntentSchema').toBe(6);
  });

  it('CRITICAL every verb the demo shows is a real member of the closed union', () => {
    const declared = new Set(schemaKinds());
    const invented = [...new Set(demoKinds())].filter((k) => !declared.has(k)).sort();
    expect(invented, 'the demo shows verbs the API does not have:').toEqual([]);
  });

  it('CRITICAL every enum VALUE the demo shows is real too — a valid verb carrying an invented action is the same lie one level down', () => {
    const actions = new Set(schemaEnum('action'));
    const captures = new Set(schemaEnum('capture'));
    const conditions = new Set(schemaEnum('condition'));
    expect(actions.size, 'interact actions parsed').toBeGreaterThan(3);

    const bad: string[] = [];
    for (const m of demo().matchAll(/"action":\s*"([a-z_]+)"/g)) {
      if (!actions.has(m[1] ?? '')) bad.push(`action=${String(m[1])}`);
    }
    for (const m of demo().matchAll(/"capture":\s*"([a-z_]+)"/g)) {
      if (!captures.has(m[1] ?? '')) bad.push(`capture=${String(m[1])}`);
    }
    for (const m of demo().matchAll(/"condition":\s*"([a-z_]+)"/g)) {
      if (!conditions.has(m[1] ?? '')) bad.push(`condition=${String(m[1])}`);
    }
    expect(bad.sort(), 'demo values absent from their declared enum:').toEqual([]);
  });

  it('CRITICAL the two verbs that always fail are not advertised — declared in the union, `{ok:false}` at runtime (D-7)', () => {
    const text = demo();
    expect(/"action":\s*"swipe"/.test(text), 'demo shows interact:swipe').toBe(false);
    expect(/"capture":\s*"pdf"/.test(text), 'demo shows capture:pdf').toBe(false);
  });

  it('the demo still shows behavioral_pause, which is the only step making a claim the competition cannot copy cheaply', () => {
    expect(demoKinds()).toContain('behavioral_pause');
  });
});
