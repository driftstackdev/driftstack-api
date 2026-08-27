// V-1924. `publicTranscriptEntry` is the last thing between an internal
// `TranscriptEntry` and a customer's live transcript SSE stream, and it is a
// DENYLIST: it spreads the entry and narrows only `intents`. Whatever else the
// internal type carries rides along.
//
// Today that is two fields of executor control state — `awaitingConfirmation`
// and `resumeFromIntentIndex` — which reach the customer through
// `JSON.stringify` in routes/agent-sessions.ts with no schema in the path to
// strip them. Measured when written: `@driftstack/api-types` declares neither,
// and no client reads either (gui-client, customer-dashboard, admin-panel and
// sdk-typescript all return zero, against 34 and 18 hits for "transcript" in the
// first and last, so the search reached those trees).
//
// Neither field is a credential, and removing them from a live stream is a
// contract change that is not this test's business. What IS this test's business
// is that `TranscriptEntry` is an INTERNAL type: the next field added to it
// reaches customers by default, without anyone choosing that. V-1886 named this
// exact shape — "a spread would inherit whatever the schema happens to allow" —
// and every other public serializer in the tree is an allowlist instead.
//
// So the emitted key set is frozen. Adding a field to TranscriptEntry is meant to
// fail here: the fix is to decide whether customers should see it, and record the
// decision by editing this list.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';
import { publicTranscriptEntry } from '../../src/services/agent-public-redaction.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECOMPOSER = resolve(HERE, '..', '..', 'src', 'services', 'agent-decomposer.ts');

/**
 * The properties `TranscriptEntry` actually declares, read from source.
 *
 * A fixture cannot stand in for this: a field added to the interface and set in
 * production would leave the fixture below untouched, and the behavioural arm
 * would stay green while the new field rode out to customers — which is the exact
 * regression this file exists to catch.
 */
function declaredTranscriptEntryKeys(): string[] {
  const sourceFile = ts.createSourceFile(
    DECOMPOSER,
    readFileSync(DECOMPOSER, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'TranscriptEntry') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
          keys.push(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys.sort();
}

/**
 * Every key the customer-facing transcript SSE stream may carry, frozen
 * 2026-08-27. Reviewed against `routes/agent-sessions.ts`, which serialises this
 * value directly with JSON.stringify — nothing downstream filters it.
 */
const EMITTED_KEYS = [
  'at',
  'awaitingConfirmation',
  'body',
  'intents',
  'resumeFromIntentIndex',
  'role',
] as const;

/** An entry with EVERY optional field populated — a partial fixture would let a
 *  field escape the check simply by being absent from the sample. */
const FULLY_POPULATED: TranscriptEntry = {
  at: '2026-08-27T00:00:00.000Z',
  role: 'agent',
  body: 'serialized DecomposeResult',
  intents: [{ kind: 'navigate', url: 'https://example.test/' }],
  awaitingConfirmation: true,
  resumeFromIntentIndex: 2,
};

describe('the transcript SSE entry emits only declared fields', () => {
  it('emits exactly the frozen key set, with every optional field present', () => {
    const emitted = Object.keys(publicTranscriptEntry(FULLY_POPULATED)).sort();
    expect(emitted).toEqual([...EMITTED_KEYS]);
  });

  it('CRITICAL every property TranscriptEntry declares is on the frozen list', () => {
    // Read from the interface, not from a fixture. Adding a field to the internal
    // type must fail HERE, before anyone notices it on a customer's stream.
    const declared = declaredTranscriptEntryKeys();
    expect(declared.length).toBeGreaterThan(3); // the read found the interface, not nothing
    expect(
      declared.filter((k) => !EMITTED_KEYS.includes(k as (typeof EMITTED_KEYS)[number])),
    ).toEqual([]);
  });

  it('a field added to the entry does ride along, which is why the list must lead the type', () => {
    const withExtra = { ...FULLY_POPULATED, someNewInternalField: 'x' } as TranscriptEntry;
    expect(Object.keys(publicTranscriptEntry(withExtra))).toContain('someNewInternalField');
  });

  it('still redacts what it exists to redact, so freezing the keys did not weaken it', () => {
    const sensitive: TranscriptEntry = {
      at: '2026-08-27T00:00:00.000Z',
      role: 'agent',
      body: 'plan',
      intents: [
        {
          kind: 'interact',
          action: 'type',
          selector: '#password',
          value: 'hunter2',
          sensitive: true,
        } as unknown as NonNullable<TranscriptEntry['intents']>[number],
      ],
    };
    const out = publicTranscriptEntry(sensitive);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });
});
