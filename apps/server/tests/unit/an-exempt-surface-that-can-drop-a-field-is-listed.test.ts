// V-961 — the same criterion V-960 applied to the anonymous surface, applied to the
// exempt ones: which of them can actually drop a field, and is that accounted for.
//
// `unknown-request-fields-coverage-invariant` waves through three groups without
// reporting — `admin-*`, the two staff files, and `status-subscribe`. Each has a
// stated reason. Neither reason mentions the property that decides whether the
// exemption costs anything: **a schema can only drop a field in silence if it has a
// field it is willing to do without.** Where every field is required, a mistyped key
// is a missing required field and zod answers 400.
//
// Measured across the 23 body-parsing schemas on those surfaces: **8 cannot drop
// anything, 15 can.** The split is not what either rationale predicts, and it matters
// in both directions.
//
// `status-subscribe` is the one whose exemption rests on the disclosure argument that
// V-951 measured and found unsound — the shapes are published, so echoing a key back
// tells a prober nothing. Its exemption turns out to be right anyway, for the reason
// nobody wrote down: `SubscribeBodySchema` has no optional field, so there is nothing
// to drop. Correct conclusion, wrong premise, and now the right premise is the one
// under test.
//
// The `admin-*` reason is "a mistyped field there is a mis-typed admin action, not a
// customer's resource silently configured as something they did not ask for". That
// addresses who is inconvenienced. It does not address what four of these routes
// actually drop: an **audit reason** on account-lifecycle actions — change tier,
// suspend, unsuspend, and the GDPR Article 17 delete. Each declares
// `reason: z.string().max(500).optional()`, documented in api-types as "recorded in
// the audit row", and each route writes
// `{ ...(body.reason ? { reason: body.reason } : {}) }` — so a mistyped `resaon`
// produces a completed account termination whose audit row carries no reason, and a
// 200 that says nothing. The operator is the one inconvenienced, which is the
// rationale's point; the audit trail is what is left incomplete, which is not.
//
// This file does not change the exemption. It stops it being inherited: the droppable
// set is pinned, so a new admin schema with an optional field joins a list somebody
// has to look at rather than sliding under a blanket written for a different concern.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');
const API_TYPES = resolve(REPO_ROOT, 'packages/api-types/src');

/** Mirrors the coverage guard's exemptions. */
// V-1370 — `admin.ts` came off this list with the sibling invariant's copy of it. It
// was never a staff surface: every route it registers is customer self-service behind
// plain `requireAuth`, and the field it could drop was `expires_at` on key creation —
// a mistyped one minted a credential with no expiry at all. That is precisely the
// "customer's resource silently configured as something they did not ask for" case
// the admin rationale says it is NOT covering. The route reports now, so the schema
// leaves this file's droppable set as well.
const EXEMPT_PREFIXES = ['admin-'] as const;
const EXEMPT_FILES = [
  'status-subscribe.ts',
  'mac-nodes-register.ts',
  'internal-atlas-priority.ts',
] as const;

const PARSE_RE =
  /(\w+Schema)\.(?:safeParse|parse)\(\s*(?:req\.body|request\.body|raw[A-Za-z]*Body)/;

/**
 * Schemas on an exempt surface that CAN silently drop a mistyped field.
 *
 * Read from source rather than imported: several are declared inside their route
 * file and never exported, and `@driftstack/api-types` resolves to `dist`, so a
 * source edit would not reach an imported copy until a rebuild.
 */
const CAN_DROP: ReadonlySet<string> = new Set([
  'admin-accounts.ts (ChangeTierRequestSchema)',
  'admin-accounts.ts (DeleteAccountRequestSchema)',
  'admin-accounts.ts (RecordRefundRequestSchema)',
  'admin-accounts.ts (SetQuotaOverrideRequestSchema)',
  'admin-accounts.ts (SuspendAccountRequestSchema)',
  'admin-accounts.ts (UnsuspendAccountRequestSchema)',
  'admin-force-actions.ts (ForceActionBodySchema)',
  'admin-incidents.ts (CreateIncidentRequestSchema)',
  'admin-owner.ts (SetSecretBodySchema)',
  'admin-validation-harness.ts (TriggerValidationScheduleBodySchema)',
  'admin-validation-harness.ts (UpsertValidationScheduleRequestSchema)',
  'internal-atlas-priority.ts (eventStatusBodySchema)',
  'internal-atlas-priority.ts (probeSignatureBodySchema)',
  'mac-nodes-register.ts (ControlNodeBodySchema)',
]);

/**
 * The four whose droppable field is an AUDIT REASON on an account-lifecycle action.
 *
 * Called out separately because this is the case the `admin-*` rationale does not
 * cover: the dropped value is not a convenience, it is the record of why a customer's
 * account was changed, suspended or deleted.
 */
const DROPS_AN_AUDIT_REASON: ReadonlyArray<readonly [string, string]> = [
  ['ChangeTierRequestSchema', 'account.tier_changed'],
  ['SuspendAccountRequestSchema', 'account.suspended'],
  ['UnsuspendAccountRequestSchema', 'account.unsuspended'],
  ['DeleteAccountRequestSchema', 'account.deleted'],
];

function isExempt(file: string): boolean {
  return EXEMPT_PREFIXES.some((p) => file.startsWith(p)) || EXEMPT_FILES.includes(file as never);
}

/** The declaration body of `const <name> = z.object({ … })`, wherever it lives. */
function schemaBody(name: string): string | null {
  for (const dir of [ROUTES, API_TYPES]) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.ts')) continue;
      const src = readFileSync(join(dir, entry), 'utf8');
      const at = new RegExp(String.raw`(?:export )?const ${name}\s*=\s*`).exec(src);
      if (at === null) continue;
      const tail = src.slice(at.index + at[0].length);
      const end = tail.indexOf('\n});');
      return end > 0 ? tail.slice(0, end) : tail.slice(0, 800);
    }
  }
  return null;
}

/** A field the schema will accept the absence of — the only way a drop is silent. */
function canDrop(body: string): boolean {
  return (
    body.includes('.optional()') ||
    body.includes('.nullish()') ||
    body.includes('.default(') ||
    body.includes('.partial()')
  );
}

/** Every `Schema.safeParse(req.body)` site on an exempt route file. */
function exemptSites(): Array<{ file: string; schema: string }> {
  const out: Array<{ file: string; schema: string }> = [];
  const seen = new Set<string>();
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    if (!isExempt(file)) continue;
    for (const line of readFileSync(join(ROUTES, file), 'utf8').split('\n')) {
      const m = PARSE_RE.exec(line);
      if (m === null) continue;
      const key = `${file} (${m[1] ?? ''})`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, schema: m[1] ?? '' });
    }
  }
  return out;
}

describe('V-961 an exempt surface that can drop a field is listed, not inherited', () => {
  const sites = exemptSites();

  // V-1373 — these two lists are duplicated by construction and were held in
  // agreement by nothing. That is not hypothetical: `admin.ts` sat on BOTH under a
  // staff-surface rationale it did not qualify for (V-1370), and fixing one copy
  // would have left the other quietly waiving a customer surface. This file's whole
  // subject is "which of the coverage invariant's exempt surfaces can drop a field",
  // so if its population stops matching that invariant's, it is auditing something
  // else and still reporting green.
  it("CRITICAL this file waives exactly the surfaces the coverage invariant waives. Read from that file's source, not re-declared, because a second copy of a waiver list is how a surface gets exempted in one place and audited in the other.", () => {
    const sibling = readFileSync(
      resolve(HERE, 'unknown-request-fields-coverage-invariant.test.ts'),
      'utf8',
    );
    // Comments blanked so a commented-out entry cannot count as declared.
    const code = sibling.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const listOf = (name: string): string[] => {
      const m = new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(code);
      return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string).sort();
    };

    const theirPrefixes = listOf('EXEMPT_PREFIXES');
    const theirFiles = listOf('EXEMPT_FILES');
    expect(
      theirPrefixes.length + theirFiles.length,
      'nothing parsed out of the coverage invariant — the extraction broke and this arm would agree with anything',
    ).toBeGreaterThan(2);

    expect(
      [...EXEMPT_PREFIXES].sort(),
      'the two files disagree on which route-file PREFIXES are waived from reporting',
    ).toEqual(theirPrefixes);
    expect(
      [...EXEMPT_FILES].sort(),
      'the two files disagree on which route FILES are waived from reporting',
    ).toEqual(theirFiles);
  });

  it('CRITICAL the scan found the exempt surface and every schema on it resolves to a declaration. Both arms below compare against a list, so a scan that found nothing, or a schema whose body could not be located, would make them agree with anything.', () => {
    expect(sites.length, 'body-parsing schemas on exempt surfaces').toBeGreaterThanOrEqual(20);
    const unresolved = sites.filter((s) => schemaBody(s.schema) === null).map((s) => s.schema);
    expect(unresolved, 'schema declarations this file could not find:').toEqual([]);
  });

  it('CRITICAL the droppable set is exactly the pinned one. An admin schema that gains an optional field starts silently dropping mistyped keys on a surface exempted for a different reason entirely — the rationale is about who is inconvenienced, not about whether anything is lost. This is what makes that a decision somebody takes rather than one they inherit.', () => {
    const live = new Set(
      sites
        .filter((s) => canDrop(schemaBody(s.schema) ?? ''))
        .map((s) => `${s.file} (${s.schema})`),
    );
    expect(
      [...live].filter((k) => !CAN_DROP.has(k)).sort(),
      'these exempt schemas can now silently drop a field and are not on the list — add them ' +
        'deliberately, or make the field required',
    ).toEqual([]);
    expect(
      [...CAN_DROP].filter((k) => !live.has(k)).sort(),
      'these are listed as droppable but no longer are — the entry is stale and should go',
    ).toEqual([]);
  });

  it('CRITICAL the four account-lifecycle routes still drop an AUDIT REASON, and each route still omits it from the audit row when absent. This is the case the admin exemption does not speak to: a mistyped `resaon` completes a tier change, a suspension or a GDPR deletion and writes an audit row with no reason, answering 200. Pinned so the shape cannot change without the exemption being reconsidered.', () => {
    const adminAccounts = readFileSync(join(ROUTES, 'admin-accounts.ts'), 'utf8');
    for (const [schema, action] of DROPS_AN_AUDIT_REASON) {
      const body = schemaBody(schema);
      expect(body, `${schema} still resolves`).not.toBeNull();
      expect(
        body ?? '',
        `${schema}.reason is no longer optional — good, but this entry now describes nothing`,
      ).toContain('reason: z.string().max(500).optional()');
      expect(adminAccounts, `${action} no longer audits through admin-accounts.ts`).toContain(
        action,
      );
    }
    // The omission itself, tied to EACH call site rather than to the file.
    //
    // The first version of this asserted the expression appeared in
    // admin-accounts.ts at all — which the file satisfies from an unrelated route,
    // so replacing it at the four sites that matter left the arm green. That is the
    // shape §5h of the readiness assessment measured across 76 anchors: a text pin
    // matching more than once asserts the block exists somewhere, not that it still
    // guards the site it was written for. Proved by mutation, not noticed by reading.
    for (const [, action] of DROPS_AN_AUDIT_REASON) {
      const at = adminAccounts.indexOf(`'${action}'`);
      expect(at, `${action} is audited in admin-accounts.ts`).toBeGreaterThan(-1);
      // The metadata argument sits between the action name and the operation thunk.
      const callSite = adminAccounts.slice(at, adminAccounts.indexOf('() =>', at));
      expect(
        callSite,
        `${action} no longer omits an absent reason from its audit metadata — if it now records ` +
          'something explicit the silent-drop concern is gone and this arm should be retired',
      ).toContain('body.reason ? { reason: body.reason } : {}');
    }
  });

  it('CRITICAL status-subscribe cannot drop anything, which is the real reason its exemption is safe. Its stated reason is the disclosure argument V-951 measured and found unsound; the exemption survives on this instead. If SubscribeBodySchema gains an optional field, the stated reason does not save it and this says so.', () => {
    const body = schemaBody('SubscribeBodySchema');
    expect(body, 'SubscribeBodySchema still resolves').not.toBeNull();
    expect(
      canDrop(body ?? ''),
      'the public status-subscribe body now has a field it will do without, so a mistyped key is ' +
        'dropped in silence on an anonymous customer surface — the exemption needs a real reason now',
    ).toBe(false);
  });

  it('CRITICAL the droppability test distinguishes a required field from an optional one. Asserted against fixtures because every real schema is currently on the correct side of it: a matcher that answered the same for both would make all three arms above agree with anything.', () => {
    expect(
      canDrop('  email: z.string().email(),\n  token: z.string().min(1),'),
      'all required',
    ).toBe(false);
    expect(canDrop('  reason: z.string().max(500).optional(),'), 'optional').toBe(true);
    expect(canDrop('  archetype: z.string().default("x"),'), 'defaulted').toBe(true);
    expect(canDrop('  note: z.string().nullish(),'), 'nullish').toBe(true);
  });
});
