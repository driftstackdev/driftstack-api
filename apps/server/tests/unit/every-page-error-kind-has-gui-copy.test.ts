// Every page-error kind the harness can report has its own customer-facing copy.
//
// `PageStateErrorKind` is produced by the harness, travels the control protocol,
// and is rendered by the desktop client through `pageErrorCopy`. The existing
// gui-jsdom test asserts the copy for four kinds by hand — dns, tls, timeout,
// net — with the literals typed out. That is a list, not a derivation: a sixth
// kind added to the schema ships with no branch, and nothing fails.
//
// What the customer sees then is the `default` branch: "This page couldn't be
// loaded." That is deliberately honest and deliberately generic, and it is the
// right fallback — it exists so a cryptic transport code (the -1004 case its
// comment records) never reaches the operator's screen. So this is not a leak,
// and the severity is bounded: a diagnosable failure presented as an
// undiagnosed one. Someone whose certificate is untrusted reads "couldn't be
// loaded" and starts debugging the wrong thing.
//
// Lives server-side rather than next to the gui test because gui-client
// deliberately does not depend on @driftstack/api-types — only on the SDK — so
// the vocabulary cannot be imported there. Reading the source as text is the
// established cross-source pattern in this suite.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PageStateErrorKindSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const COPY_SRC = resolve(HERE, '..', '..', '..', 'gui-client', 'src', 'lib', 'page-error-copy.ts');

/** A kind is handled when the switch has a branch for it. */
function hasBranch(source: string, kind: string): boolean {
  return new RegExp(`case '${kind}':`).test(source);
}

describe('every page-error kind has dedicated GUI copy', () => {
  const source = readFileSync(COPY_SRC, 'utf8');
  const kinds = PageStateErrorKindSchema.options;

  it('CRITICAL the source was read and the detector can tell a handled kind from an unhandled one', () => {
    // Both controls. A file that failed to load, or a matcher that matches
    // anything, would make the assertion below pass while checking nothing.
    expect(kinds.length, 'the kind vocabulary did not load').toBeGreaterThanOrEqual(4);
    expect(source, 'page-error-copy.ts does not look like the switch it should be').toContain(
      'switch (err.kind)',
    );
    expect(hasBranch(source, 'dns'), 'dns is handled but the detector missed it').toBe(true);
    expect(
      hasBranch(source, 'kind_that_does_not_exist'),
      'the detector claims a branch that is not there',
    ).toBe(false);
  });

  it('CRITICAL every kind in the schema has its own branch, not the generic fallback', () => {
    const unhandled = kinds.filter((k) => !hasBranch(source, k)).sort();
    expect(
      unhandled,
      'the harness can report this page-error kind and the desktop client has no copy for it, so ' +
        'the customer gets "This page couldn’t be loaded." for a failure we could have named. Add ' +
        'a case to pageErrorCopy',
    ).toEqual([]);
  });

  it('CRITICAL the generic fallback still exists, because it is what bounds the damage', () => {
    // The reason this file is a UX guard rather than a security one. If the
    // default branch were ever changed to surface `err.message`, an unhandled
    // kind would put raw harness text (e.g. -1004) in front of the operator,
    // and the case above would stop being the whole story.
    expect(source, 'the honest generic fallback is gone').toContain(
      "This page couldn't be loaded.",
    );
    const defaultBranch = source.slice(source.indexOf('default:'));
    expect(
      defaultBranch,
      'the fallback now surfaces the raw harness message — an unhandled kind would leak a ' +
        'transport code to the customer, not merely under-describe the failure',
    ).not.toMatch(/return\s+[^;]*err\.message/);
  });
});
