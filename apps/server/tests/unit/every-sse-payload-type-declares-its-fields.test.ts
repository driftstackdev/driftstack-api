// V-1925. Two SSE streams serialise a whole internal object to the customer.
//
//   routes/status-stream.ts:125        `data: ${JSON.stringify(event)}`  IncidentEvent
//   routes/account-notifications.ts:162 `data: ${JSON.stringify(event)}`  NotificationEvent
//
// Both types are wire-designed — `IncidentEvent` uses snake_case `generated_at`,
// and `NotificationEvent`'s only per-account field is the recipient's own id,
// which its bus comments call out deliberately. Neither is a defect.
//
// But neither lives in `@driftstack/api-types` (zero mentions), and nothing in
// the path validates or projects: `JSON.stringify` writes whatever the type
// happens to carry. So the next field added to either — including one that ought
// not to be public — reaches every subscribed customer by default, chosen by
// nobody. That is the shape V-1886 named and V-1924 froze for the transcript
// stream; these are the other two SSE payload types.
//
// One guard rather than three copies of one: V-1922 recorded six copies of a
// helper drifting into three behaviours, and the fix for that is not a seventh
// copy. TranscriptEntry is deliberately NOT re-pinned here — it already has
// `the-transcript-sse-entry-emits-only-declared-fields`, which also proves the
// redaction that file exists for.
//
// Adding a field to either type is meant to fail this test: decide whether
// subscribers should see it, then record the decision by editing the list.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(HERE, '..', '..', 'src', 'services');

/**
 * Property names a type declares, read from source. Handles both an interface
 * and a discriminated union of object literals — `NotificationEvent` is the
 * latter, and taking only the first member would silently pin a quarter of it.
 */
function declaredKeys(file: string, typeName: string): string[] {
  const path = resolve(SERVICES, file);
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const keys = new Set<string>();
  const collectMembers = (node: ts.Node): void => {
    if (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node)) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name))
          keys.add(member.name.text);
      }
    }
    ts.forEachChild(node, collectMembers);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) collectMembers(node);
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) collectMembers(node.type);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...keys].sort();
}

/** Frozen 2026-08-27. Every key either stream may put on a customer's socket. */
const EXPECTED: Record<string, { file: string; keys: string[] }> = {
  IncidentEvent: {
    file: 'incident-event-bus.ts',
    keys: ['event', 'generated_at', 'incident', 'update'],
  },
  NotificationEvent: {
    file: 'notification-event-bus.ts',
    keys: [
      'accountId',
      'action',
      'actorType',
      'at',
      'billingCycle',
      'currentState',
      'errorClass',
      'incidentId',
      'kind',
      'previousState',
      'sessionId',
      'severity',
      'targetResourceId',
      'thresholdHardCents',
      'thresholdSoftCents',
      'title',
      'totalCents',
    ],
  },
};

describe('every SSE payload type declares its fields', () => {
  it('IncidentEvent emits exactly the frozen key set', () => {
    const declared = declaredKeys('incident-event-bus.ts', 'IncidentEvent');
    expect(declared.length).toBeGreaterThan(2); // the read found the type, not nothing
    expect(declared).toEqual(EXPECTED.IncidentEvent?.keys);
  });

  it('NotificationEvent emits exactly the frozen key set, across ALL union members', () => {
    const declared = declaredKeys('notification-event-bus.ts', 'NotificationEvent');
    // A union of four members: taking only the first would pin ~5 of these.
    expect(declared.length).toBeGreaterThan(10);
    expect(declared).toEqual(EXPECTED.NotificationEvent?.keys);
  });

  it('the reader finds nothing for a type that is not there', () => {
    expect(declaredKeys('incident-event-bus.ts', 'NoSuchTypeName')).toEqual([]);
  });
});
