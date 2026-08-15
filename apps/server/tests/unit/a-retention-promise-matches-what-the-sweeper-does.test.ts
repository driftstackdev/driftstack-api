// The privacy policy promises the verb the code actually performs.
//
// §9's retention table told customers that revoked API-key records were
// "retained 90 days for audit then deleted". Nothing deleted them, and nothing
// could: `api_keys` is RESTRICT-referenced by admin_audit_log, incidents,
// incident_updates, rate_limit_overrides and sessions — audit rows outlive the
// key on purpose, so that an audit entry can never point at a vanished actor.
// Deleting the row is not merely unimplemented, it is refused by the database.
//
// The sweeper does the defensible thing instead: it ANONYMISES in place, which
// §9's own closing paragraph authorises ("deletes the Personal Data or
// anonymises it"). What was wrong was the specific row, which kept promising
// deletion — and a customer reading a retention schedule reads the row, not the
// general clause three paragraphs below it.
//
// THE PIN FROZE THE PROMISE RATHER THAN THE BEHAVIOUR. A content-parity test
// asserted the sentence verbatim, so the false claim was protected by a passing
// test for as long as it stood. That is the failure mode this file is built
// against: a pin records what the text SAID, never whether it was TRUE.
//
// So this reads BOTH SIDES at runtime and asserts they agree, rather than
// pinning either. The sweeper's verb is measured from its SQL; the policy's verb
// is measured from its table row; a disagreement fails. That makes the guard
// bidirectional — if someone later implements real deletion, this fails until
// the policy is updated to promise it, which is the same protection pointing the
// other way.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const SCRUB = resolve(REPO_ROOT, 'apps/server/src/db/retention-scrub-repo.ts');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
const POLICY = resolve(REPO_ROOT, 'docs/legal/privacy-policy.md');
const POLICY_MIRROR = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/privacy.md');

/** Source with comment lines removed — the prose here discusses both verbs. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/**
 * How many places refuse to let an `api_keys` row be deleted.
 *
 * This is the premise the whole argument rests on, so it is measured rather than
 * asserted in prose: if these ever become CASCADE, deletion becomes possible and
 * the policy question genuinely reopens.
 */
function restrictReferencesToApiKeys(): number {
  const schema = code(readFileSync(SCHEMA, 'utf8'));
  let count = 0;
  for (const match of schema.matchAll(/apiKeys\.id/g)) {
    // The options object may sit on the same line or the next few.
    const window = schema.slice(match.index, match.index + 160);
    if (/onDelete:\s*'restrict'/.test(window)) count += 1;
  }
  return count;
}

/**
 * The verb the retention sweeper performs on `api_keys`.
 *
 * Each `WITH due AS (…) … RETURNING` block is isolated FIRST, then the one
 * naming `api_keys` is selected. The obvious regex — span from `WITH due AS (`
 * to `FROM api_keys` — is wrong here and was wrong when written: the file holds
 * THREE such statements and the first targets `sessions`, so a lazy span starts
 * at the sessions block and runs through the api_keys one, covering all three.
 * It returned the right verb by accident, because the span happened to contain
 * the api_keys UPDATE. An extraction that is correct by luck is not an
 * extraction.
 */
function sweeperVerb(): 'anonymise' | 'delete' | 'unknown' {
  const scrub = code(readFileSync(SCRUB, 'utf8'));
  const blocks = [...scrub.matchAll(/WITH due AS \([\s\S]*?RETURNING/g)].map(([b]) => b);
  const forApiKeys = blocks.filter((b) => /\bapi_keys\b/.test(b));
  // Exactly one statement may claim api_keys; two would make "the verb"
  // ambiguous and this guard would be picking one arbitrarily.
  if (forApiKeys.length !== 1) return 'unknown';
  const statement = forApiKeys[0] ?? '';
  if (/DELETE\s+FROM\s+api_keys/i.test(statement)) return 'delete';
  if (/UPDATE\s+api_keys/i.test(statement)) return 'anonymise';
  return 'unknown';
}

/** How many `WITH due AS` statements the scrub file contains, for the arm below. */
function scrubStatementCount(): number {
  return [...code(readFileSync(SCRUB, 'utf8')).matchAll(/WITH due AS \(/g)].length;
}

/** The §9 row covering authentication data, from a published copy. */
function policyRow(file: string): string {
  const body = readFileSync(file, 'utf8');
  return (
    /^\|\s*Authentication data \(hashed API keys, key metadata\)\s*\|.*$/m.exec(body)?.[0] ?? ''
  );
}

/** The verb that row promises a customer. */
function policyVerb(row: string): 'anonymise' | 'delete' | 'unknown' {
  const promisesDeletion = /\bdeleted\b/i.test(row);
  const promisesAnonymisation = /\banonymised\b/i.test(row);
  if (promisesDeletion && !promisesAnonymisation) return 'delete';
  if (promisesAnonymisation && !promisesDeletion) return 'anonymise';
  return 'unknown';
}

describe('a retention promise matches what the sweeper does', () => {
  it('CRITICAL both sides were actually read. Every assertion below compares a verb extracted from the sweeper against one extracted from the policy, and two failed extractions compare "unknown" to "unknown" — a scan that found neither would report perfect agreement having read nothing.', () => {
    expect(sweeperVerb(), 'the sweeper statement for api_keys was found').not.toBe('unknown');
    expect(policyRow(POLICY), 'the §9 authentication-data row was found').not.toBe('');
    expect(policyVerb(policyRow(POLICY)), 'and its verb is unambiguous').not.toBe('unknown');
  });

  it('CRITICAL the scrub file holds several statements and exactly one claims api_keys. The first version of this extraction spanned from the FIRST `WITH due AS (` — which targets `sessions` — through to the api_keys block, covering all three statements at once. It reported the right verb because the span happened to contain the right UPDATE. This arm fails if a second statement ever touches api_keys, which is the case where "the verb" stops being well defined.', () => {
    // MEASURED: 3 statements in the file, exactly 1 naming api_keys.
    expect(scrubStatementCount(), 'WITH due AS statements in the scrub').toBeGreaterThanOrEqual(3);
    expect(sweeperVerb(), 'a single api_keys statement resolved to a verb').not.toBe('unknown');
  });

  it('CRITICAL deleting an api_keys row is still refused by the database. This is the premise the policy wording rests on — audit rows outlive the key so an audit entry can never point at a vanished actor. If these references ever become CASCADE, deletion is possible again and the wording below is no longer forced.', () => {
    // MEASURED: 5 RESTRICT references to apiKeys.id — three declared inline and
    // two across multiple lines. Counted, not eyeballed: a first mutation that
    // rewrote only the single-line form left the other two standing and this arm
    // stayed green, which looked like a guard failure and was a bad mutation.
    expect(
      restrictReferencesToApiKeys(),
      'RESTRICT references to apiKeys.id blocking deletion',
    ).toBeGreaterThanOrEqual(1);
  });

  it('CRITICAL the policy promises the verb the sweeper performs. The row said "then deleted" while the sweeper ran an UPDATE, and a content-parity pin held that sentence in place — so the false promise was protected by a passing test. Reading both sides means neither can drift alone, in either direction.', () => {
    expect(policyVerb(policyRow(POLICY)), 'policy verb vs sweeper verb').toBe(sweeperVerb());
  });

  it('CRITICAL the published mirror carries the identical row. The policy ships twice — docs/legal and the marketing site — and a correction applied to one leaves the other telling customers the version that was wrong.', () => {
    expect(policyRow(POLICY_MIRROR), 'marketing-site copy of the row').toBe(policyRow(POLICY));
    expect(policyRow(POLICY_MIRROR), 'and it is not empty').not.toBe('');
  });
});
