// Nothing about an unreleased feature is in the published spec.
//
// The OpenAPI document is public: it is served by the API, committed for the
// SDKs to generate from, and read by customers. A request schema registered
// straight from api-types publishes every field it has the moment the field is
// written — which is how `monthly_credits`, a field of a feature that is built
// and switched off, reached the admin tier route's published body the day it was
// added, with two snapshot guards asking for it to be committed.
//
// The rule this holds: a term that names an unreleased feature does not appear
// anywhere in the generated document. It is two-sided. Each entry names WHY the
// term is withheld and what makes it releasable; an entry whose feature has
// shipped must be removed (together with the omit in openapi.ts that it guards),
// and an entry that is no longer needed — the route stopped accepting the field —
// fails too, so the list cannot outlive its reason.

import { describe, expect, it } from 'vitest';
import { ChangeTierRequestSchema } from '@driftstack/api-types';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';

interface Withheld {
  /** Matched case-insensitively against the whole serialized document. */
  term: RegExp;
  why: string;
  /** True while the API really does accept something the document leaves out. */
  stillAccepted: () => boolean;
}

const WITHHELD: readonly Withheld[] = [
  {
    term: /credit/i,
    why:
      'AI credits are built and switched off (the mode flag defaults to off and no account ' +
      'is on them). Publish the admin tier field, and remove this entry and the omit in ' +
      'openapi.ts, in the change that makes them live.',
    stillAccepted: () => 'monthly_credits' in ChangeTierRequestSchema.shape,
  },
];

describe('nothing about an unreleased feature is in the published spec', () => {
  const document = JSON.stringify(generateOpenApiSpec());

  it('CONTROL — the document is really generated and really searched: a term it must contain is found', () => {
    expect(document.length).toBeGreaterThan(100_000);
    expect(/agent-sessions/i.test(document)).toBe(true);
  });

  for (const entry of WITHHELD) {
    it(`CRITICAL the published document never mentions ${String(entry.term)} — ${entry.why}`, () => {
      const at = document.search(entry.term);
      expect(
        at === -1 ? null : document.slice(Math.max(0, at - 80), at + 80),
        'an unreleased feature reached the public document',
      ).toBeNull();
    });

    it(`an entry that withholds nothing is removed: the API still accepts what ${String(entry.term)} hides`, () => {
      expect(entry.stillAccepted()).toBe(true);
    });
  }
});
