// An optional dependency the production graph never passes is a feature that
// exists only in tests.
//
// Adding an optional dep breaks no call site, so "it compiles and the tests are
// green" says nothing about whether bootstrap supplies it — and unit tests
// build their own deps, so no test in the suite can see the wiring. Three
// instances so far:
//
//   • AccountsAdminService.logger — added so a failed GDPR Article 17 reclaim
//     would stop being silent; 30 green tests against a path that logged
//     nothing, because bootstrap passed six args to a seven-arg constructor.
//   • WebhookWorkerConfig.metrics — both delivery counters were registered at
//     boot and emitted only from the unwired successor, so they could never
//     increment in production (see the comment at that call site).
//   • CryptoOrdersServiceOpts.paidEmailNotifier — still unwired, declared
//     below. Its own doc comment says "Production wiring routes through the
//     existing EmailService template path", which is not true today.
//
// So this does not report a problem. It fixes the state where the NEXT one is
// added unnoticed: the roster below is exact, so a newly unwired optional dep
// fails until somebody writes down why it is unwired — and an entry that stops
// describing a real gap fails too, because an exemption that exempts nothing
// reads as reviewed.
//
// Most entries are test seams (clocks, fetch injection, timeouts) whose
// defaults are the production behaviour. That is precisely why the roster
// needs writing down: the interesting one is indistinguishable from them
// without a reason attached.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src');
const BOOTSTRAP = resolve(SRC, 'lib/bootstrap.ts');

/**
 * Optional deps bootstrap does not pass, and why each is acceptable.
 *
 * Keyed `Class.dep`. Exact in both directions.
 */
const DECLARED: Record<string, string> = {
  'AuthCoalescer.logger':
    'Emits a debug-level line per coalesced auth hit. Wiring it would log on ' +
    'the hottest path in the service for no operational benefit; the ' +
    'coalescer already exposes starts/hits counters for that.',
  'DrizzleRecipesRepo.clock':
    'Clock injection seam inside a bag bootstrap DOES pass. The default ' +
    '() => new Date() IS the production behaviour — verified at the call site, ' +
    'not assumed from the name.',
  'DrizzleAgentSessionsRepo.clock':
    'Same seam and same verified default as DrizzleRecipesRepo.clock. Both ' +
    'became visible only when the detector learned to look inside a supplied ' +
    'inline option bag.',
  'DrizzleAgentTurnReceiptsRepo.options':
    'Clock injection seam. The default () => new Date() IS the production ' +
    'behaviour; the encryption key, which is not optional, is passed.',
  'StripeApiClient.timeoutMs': 'Test seam; the default is the production timeout.',
  'StripeApiClient.baseUrl': 'Test seam; the default is the real Stripe API base.',
  'StripeApiClient.fetchImpl': 'Test seam; defaults to the platform fetch.',
  'NowPaymentsApiClient.timeoutMs': 'Test seam; the default is the production timeout.',
  'NowPaymentsApiClient.baseUrl': 'Test seam; the default is the real NowPayments API base.',
  'NowPaymentsApiClient.fetchImpl': 'Test seam; defaults to the platform fetch.',
  'CryptoOrdersService.nowFn': 'Clock injection seam; the default is the real clock.',
  'CryptoOrdersService.paidEmailNotifier':
    'NOT a seam — a real gap. V-666.R added a "paid receipt email" intent ' +
    'emitter and its doc comment claims production routes it through the ' +
    'EmailService template path, but nothing passes it, so no dedicated ' +
    'crypto receipt is sent. Paying customers are NOT silent-failed: the ' +
    'tierActivator (wired) emits subscription.tier_changed, which sends the ' +
    'tier-changed email and writes the audit row. Wiring a second, dedicated ' +
    'receipt needs a new customer-facing template and is a product decision, ' +
    'so it is recorded here rather than shipped quietly.',
  'WebhookDeliveryWorker.fetch': 'Test seam; defaults to the SSRF-pinned outbound fetch.',
  'WebhookDeliveryWorker.sleep': 'Test seam; defaults to a real timer.',
  'WebhookDeliveryWorker.now': 'Clock injection seam; the default is the real clock.',
  'WebhookDeliveryWorker.deliveryTimeoutMs': 'Test seam; the default is the production timeout.',
  'WebhookDeliveryWorker.idleSleepMs': 'Test seam; the poller cadence is set by its scheduler.',
};

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const sourceFiles = walk(SRC).filter((f) => f.endsWith('.ts'));
const allSource = sourceFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const bootstrapSource = readFileSync(BOOTSTRAP, 'utf8');

// V-1256 — comment stripping is the SHARED scanner. The private `/\*[\s\S]*?\*\//`
// pass that used to live here runs BEFORE line comments and cannot tell that the `/*`
// in `// … /v1/agent-sessions/* routes` is inside one, so it opens a comment there and
// closes it at the next `*/` far below. Measured on that file: all 61 imports vanished,
// and on `lib/internal-fleet-auth.ts` all 3. Eighteen files under `apps/server/src`
// carry that shape, nearly all route paths with a wildcard. `code-only.ts` models line
// comments, string literals and regex literals, and keeps line numbers (V-1254).
function stripComments(text: string): string {
  return codeOnly(text);
}

/** Balanced text starting at an opening bracket index. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i] ?? '';
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** Split on top-level commas. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((a) => a.length > 0);
}

/**
 * Keys supplied by an object literal, at any depth.
 *
 * Conditional spreads — `...(x !== undefined ? { metrics: x } : {})` — supply a
 * key a line-anchored matcher cannot see. Over-reporting PRESENCE is the safe
 * direction here: the cost of a miss is a dep left off the roster, while the
 * cost of a false hit is a red build over correct code.
 */
function suppliedKeys(literal: string): Set<string> {
  const keys = [...literal.matchAll(/(\w+)\s*:/g)].map((m) => m[1] ?? '');
  const shorthand = [...literal.matchAll(/(?:^|[,{])\s*(\w+)\s*(?=[,}]|$)/gm)].map(
    (m) => m[1] ?? '',
  );
  return new Set([...keys, ...shorthand]);
}

/** Optional top-level members of an object-type BODY (the text inside its braces). */
function optionalMembersOfBody(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (const line of stripComments(body).split('\n')) {
    if (depth === 0) {
      const m = line.trim().match(/^(\w+)\?\s*:/);
      if (m?.[1] !== undefined) names.push(m[1]);
    }
    depth += (line.match(/[{[]/g) ?? []).length - (line.match(/[}\]]/g) ?? []).length;
  }
  return names;
}

/** Optional top-level members of an interface. */
function optionalMembers(iface: string): string[] {
  const decl = allSource.indexOf(`export interface ${iface} {`);
  if (decl === -1) return [];
  return optionalMembersOfBody(balanced(allSource, allSource.indexOf('{', decl)));
}

/**
 * Constructor parameters whose type is an INLINE object literal, per class.
 *
 * `depsTypeOf` below only sees a single-parameter constructor typed by a NAMED
 * interface. A repo written as
 *
 *   constructor(private readonly database: Database, options: { a?: X } = {})
 *
 * falls through to the positional path, which sees both arguments supplied and
 * never looks INSIDE the bag — so every optional key in it was invisible.
 * Measured: dropping both `onUndecryptableSecret` wirings from bootstrap left
 * this file green at 4/4.
 */
function inlineBagParams(): Map<string, Map<number, string[]>> {
  const out = new Map<string, Map<number, string[]>>();
  for (const file of sourceFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/export class (\w+)[^{]*\{/g)) {
      const ctor = src.indexOf('constructor(', m.index);
      if (ctor === -1) continue;
      const params = splitTopLevel(stripComments(balanced(src, ctor + 'constructor'.length)));
      const bags = new Map<number, string[]>();
      params.forEach((param, i) => {
        const colon = param.indexOf(':');
        if (colon === -1) return;
        // Only a conventional option BAG. A dep that merely happens to be typed
        // as an object — `logger?: { error?: … }` — is a single optional dep the
        // positional path already reports, and reading its members as bag keys
        // reported `AccountsAdminService.error`, which is not a dependency at all.
        const name = param
          .slice(0, colon)
          .trim()
          .replace(/^(private|public|protected|readonly)\s+/g, '');
        if (!/^(options|opts|config|deps)\??$/.test(name)) return;
        const typeText = param.slice(colon + 1).trim();
        if (!typeText.startsWith('{')) return;
        const keys = optionalMembersOfBody(balanced(typeText, 0));
        if (keys.length > 0) bags.set(i, keys);
      });
      if (bags.size > 0) out.set(m[1] ?? '', bags);
    }
  }
  return out;
}

/** Positional constructors, and whether each param is optional. */
function positionalConstructors(): Map<string, Array<{ name: string; optional: boolean }>> {
  const out = new Map<string, Array<{ name: string; optional: boolean }>>();
  for (const file of sourceFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/export class (\w+)[^{]*\{/g)) {
      const ctor = src.indexOf('constructor(', m.index);
      if (ctor === -1) continue;
      const nextClass = src.indexOf('export class ', (m.index ?? 0) + 1);
      if (nextClass !== -1 && ctor > nextClass) continue;
      const params = splitTopLevel(stripComments(balanced(src, ctor + 'constructor'.length))).map(
        (p) => ({
          name: (
            p.replace(/^(?:private|public|protected|readonly|\s)+/g, '').split(/[:?]/)[0] ?? ''
          ).trim(),
          optional: /=\s*null|=\s*undefined|\?\s*:/.test(p),
        }),
      );
      if (params.length > 0) out.set(m[1] ?? '', params);
    }
  }
  return out;
}

/** `Class.dep` for every optional dep bootstrap does not supply. */
function unwiredOptionalDeps(bootstrap: string): string[] {
  const found: string[] = [];
  const ctors = positionalConstructors();
  const inlineBags = inlineBagParams();

  // deps-object shape: new X({ … }) against an interface with optional members
  const depsTypeOf = new Map<string, string>();
  for (const src of sourceFiles.map((f) => readFileSync(f, 'utf8'))) {
    for (const m of src.matchAll(
      /export class (\w+)[^{]*\{[\s\S]{0,600}?constructor\(\s*(?:private |public |protected |readonly |\s)*\w+:\s*(\w+)\s*\)/g,
    )) {
      depsTypeOf.set(m[1] ?? '', m[2] ?? '');
    }
  }

  for (const m of bootstrap.matchAll(/new (\w+)\(/g)) {
    const cls = m[1] ?? '';
    const argStart = (m.index ?? 0) + m[0].length - 1;
    const argText = balanced(bootstrap, argStart);
    if (argText.trimStart().startsWith('{')) {
      const iface = depsTypeOf.get(cls);
      if (iface === undefined) continue;
      const supplied = suppliedKeys(balanced(bootstrap, bootstrap.indexOf('{', argStart)));
      for (const dep of optionalMembers(iface)) {
        if (!supplied.has(dep)) found.push(`${cls}.${dep}`);
      }
      continue;
    }
    const args = splitTopLevel(stripComments(argText));

    // Optional keys inside an inline option-bag argument.
    const bags = inlineBags.get(cls);
    if (bags !== undefined) {
      for (const [index, keys] of bags) {
        const arg = args[index];
        // Only a bag that IS supplied. An omitted bag is already reported by the
        // positional path as `${cls}.${paramName}` and carries its own roster
        // entry; reporting each key again would be the same gap counted twice.
        if (arg === undefined || !arg.trimStart().startsWith('{')) continue;
        const supplied = suppliedKeys(balanced(arg, arg.indexOf('{')));
        for (const key of keys) {
          if (!supplied.has(key)) found.push(`${cls}.${key}`);
        }
      }
    }

    const params = ctors.get(cls);
    if (params === undefined) continue;
    for (const p of params.slice(args.length)) {
      if (p.optional) found.push(`${cls}.${p.name}`);
    }
  }
  return [...new Set(found)];
}

describe('every optional dependency bootstrap does not pass is declared', () => {
  it('CRITICAL the detector finds unwired deps AND does not report deps supplied by a conditional spread. Both assertions below report an absence, so a matcher that stopped matching satisfies them having inspected nothing — and the spread case is not hypothetical: it reported a wired metrics registry as missing.', () => {
    const KNOWN_BAD = `
      const svc = new AccountsAdminService(
        accountsAdminRepo,
        authCache,
      );
    `;
    // AccountsAdminService really does take an optional logger, so this is the
    // repository's own shape rather than a fixture written to suit the test.
    // The inline-bag path needs its own case: it is a SEPARATE branch, and a
    // detector that stopped looking inside supplied bags would satisfy the
    // roster assertion below having inspected nothing. DrizzleRecipesRepo really
    // does take `options: { clock?: … }`, so this is the repository's own shape.
    const bagOmitted = unwiredOptionalDeps(
      'const r = new DrizzleRecipesRepo(dbHandle, { encryptionKeyBase64: key });',
    );
    expect(
      bagOmitted,
      'a key missing from a SUPPLIED inline option bag must be reported',
    ).toContain('DrizzleRecipesRepo.clock');
    expect(
      unwiredOptionalDeps('const r = new DrizzleRecipesRepo(dbHandle, { clock: c });'),
      'and a key the bag DOES supply must not be',
    ).not.toContain('DrizzleRecipesRepo.clock');

    const missed = unwiredOptionalDeps(KNOWN_BAD);
    expect(missed, 'the detector must report a dep the call site omits').toContain(
      'AccountsAdminService.logger',
    );

    // The conditional-spread form supplies the key. Reporting it is the false
    // alarm that would get this guard deleted.
    const SPREAD_OK = `
      const w = new WebhookDeliveryWorker({
        repo: webhooksRepo,
        ...(metricsRegistry !== undefined ? { metrics: metricsRegistry } : {}),
      });
    `;
    expect(
      unwiredOptionalDeps(SPREAD_OK),
      'a dep supplied through a conditional spread is wired',
    ).not.toContain('WebhookDeliveryWorker.metrics');
  });

  it('CRITICAL the scan reached the real bootstrap and found construction sites. Without this a wrong path reports the same clean result as a fully-wired graph.', () => {
    expect(existsSync(BOOTSTRAP), 'bootstrap.ts at the canonical path').toBe(true);
    expect(
      [...bootstrapSource.matchAll(/new (\w+)\(/g)].length,
      'service constructions in bootstrap',
    ).toBeGreaterThan(20);
    // V-937 — raised from 100 to just under the measured 338. A floor at 100
    // tolerated losing two thirds of the tree while still reporting a green.
    expect(sourceFiles.length, 'server source files scanned').toBeGreaterThan(300);
  });

  it('CRITICAL no optional dependency is left unwired without a written reason. An unwired optional dep is a feature that exists only in tests: it compiles, and every unit test builds its own deps, so nothing else in the suite can see it.', () => {
    const undeclared = unwiredOptionalDeps(bootstrapSource).filter(
      (dep) => DECLARED[dep] === undefined,
    );
    expect(
      undeclared,
      'optional dep(s) production never passes, with no entry saying why — wire it, or declare why the default is the production behaviour:',
    ).toEqual([]);
  });

  it('CRITICAL every declaration still describes a genuinely unwired dep. An entry for a dep that is now wired exempts nothing and reads as reviewed.', () => {
    const unwired = new Set(unwiredOptionalDeps(bootstrapSource));
    expect(
      Object.keys(DECLARED).filter((dep) => !unwired.has(dep)),
      'declaration(s) that no longer describe an unwired dep:',
    ).toEqual([]);
  });

  // V-1432 — the inverse of everything above: a dep that MUST stay wired.
  //
  // This file rosters optional deps bootstrap does not pass. The mirror risk has no
  // guard: a security-critical dep bootstrap DOES pass being quietly dropped. The
  // roster cannot see that — removing an argument makes the dep unwired, which this
  // file would then ask someone to *declare* rather than treat as a regression.
  //
  // `ProfilesService`'s live-session guard is the case. Its 6th constructor
  // parameter defaults to null and fails OPEN, so dropping the argument in bootstrap
  // silently disables `assertNoActiveSession` — and every test of that guard builds
  // the service directly with a repo, so all of them stay green. The bootstrap call
  // site records what that costs: a profile hard-deleted, or its identity
  // transferred away, while an agent session still holds it bound.
  //
  // The comment on the parameter itself claimed no caller wired it, which was true
  // once and lapsed when the 2026-06-30 audit fix landed. Corrected in the same
  // change — but a comment is not a guard, which is why this arm exists.
  it('CRITICAL bootstrap still passes the agent-sessions repo into ProfilesService. The parameter fails OPEN when omitted, so dropping it disables the live-session guard on purge and transfer while every direct-construction test of that guard stays green.', () => {
    const call = /new ProfilesService\(([\s\S]*?)\n {2}\);/.exec(bootstrapSource);
    expect(
      call?.[1],
      'the ProfilesService construction is no longer readable in bootstrap',
    ).toBeDefined();

    const args = stripComments(call?.[1] ?? '');
    expect(
      /\bagentSessionsRepo\b/.test(args),
      'bootstrap no longer passes agentSessionsRepo to ProfilesService — the live-session guard on purge/transfer is fail-open and is now inert in production',
    ).toBe(true);
  });

  // V-1433 — the same must-stay-wired shape, on the customer audit log.
  //
  // Five services take the audit recorder as an OPTIONAL parameter defaulting to
  // null, and every emit site opens with a fail-open skip (`if (this.accountAudit
  // === null) return;`). Drop the argument in bootstrap and the rows simply stop
  // being written — no error, no degraded mode, nothing to notice.
  //
  // Measured on `WebhooksService`: with the argument removed, `tsc` exits 0 (the
  // parameter is optional) and 123 tests across the bootstrap parity guard, the
  // audit-action invariant, and the webhooks + account-audit integration suites all
  // pass. Neither the type system nor the behaviour tests can see it.
  //
  // `ProfileSnapshotsService` is already safe, and shows why this arm is shaped the
  // way it is: `lib-bootstrap-content-parity` pins its construction with the full
  // argument list, audit recorder included. The other four are pinned only by
  // COMMENTS describing the wiring — text that survives the argument being deleted.
  //
  // The surface matters: `account-audit-action-cross-source-invariant` calls the
  // customer audit log a GDPR Article 20 portability surface. Rows that were never
  // written cannot be exported.
  const AUDIT_WIRED: ReadonlyArray<readonly [service: string, why: string]> = [
    ['WebhooksService', 'webhook_endpoint.{created,deleted}'],
    ['ApiKeysService', 'customer-facing api-key audit emit (V-216)'],
    ['SessionsService', 'session lifecycle audit emit'],
    ['TeamMembersService', 'team membership changes'],
    ['ProfileSnapshotsService', 'snapshot create/delete (already pinned by bootstrap parity)'],
    // V-1434 — these two were in V-1433's census and absent from its table, because
    // that sweep matched only `if (dep === null) return`. Each fails open through a
    // form that pattern cannot see:
    //   PairModeHeartbeatSweep            `this.deps.accountAudit?.record(...)`
    //   DrizzleAgentDecomposerUsageRecorder  `if (this.accountAudit !== null) { ... }`
    // Optional chaining and a positive-form guard are the same fail-open as the early
    // return; only the syntax differs, and the syntax is what the regex keyed on.
    ['PairModeHeartbeatSweep', 'agent_session.pair_mode.timeout'],
    ['DrizzleAgentDecomposerUsageRecorder', 'decomposer usage + key_source metadata'],
    // V-1441 — the four the hand-written table never had. Found by deriving the set
    // rather than extending the list a third time: the completeness arm below now
    // computes who accepts a fail-open recorder, and these are what it returned that
    // this table did not already name. All four ARE wired today; none was checked.
    ['ProfilesService', 'profile.{created,deleted,exported,imported,purged,restored}'],
    ['AuthFlowsService', 'account.{login,logout,email_verified,password_changed}'],
    ['AccountLifecycleService', 'subscription.tier_changed + billing.payment_{succeeded,failed}'],
    ['MfaService', 'account.{mfa_enrolled,mfa_disabled,recovery_code_used}'],
  ];

  /** Bootstrap's argument list for `new <Service>(`, comments stripped.
   *  Balanced-paren rather than a regex: V-1441 added MfaService, which bootstrap
   *  builds inside a ternary (`? new MfaService(`) at a deeper indent, and the
   *  previous `\n {2}\)` terminator could not see a construction that does not
   *  close at two-space indentation. A pattern that silently fails to match reads
   *  here as "no audit argument", which is a false RED — the loud direction, but
   *  still the extractor deciding the result. */
  function constructionArgs(service: string): string | null {
    const at = bootstrapSource.indexOf(`new ${service}(`);
    if (at === -1) return null;
    return stripComments(balanced(bootstrapSource, bootstrapSource.indexOf('(', at)));
  }

  it.each(AUDIT_WIRED)(
    'CRITICAL bootstrap still passes the audit recorder into %s (%s). The parameter is optional and every emit fails OPEN, so a dropped argument silently stops writing customer audit rows — tsc accepts it and the behaviour tests cannot see it.',
    (service) => {
      const args = constructionArgs(service);
      expect(args, `the ${service} construction is no longer readable in bootstrap`).not.toBeNull();
      expect(
        /\baccountAudit(?:Service)?\b/.test(args ?? ''),
        `bootstrap no longer passes the audit recorder to ${service} — its audit emits are fail-open and now write nothing`,
      ).toBe(true);
    },
  );

  // V-1441 — the table above is hand-written, and its own V-1434 note records that
  // the previous census missed two entries because the detector keyed on syntax.
  // That is the failure mode of every roster: it is a statement about the moment it
  // was written, and a NEW service accepting a fail-open recorder is simply absent
  // from it — not reported, just never asked about. So derive the set and require
  // the table to cover it. This is the same upgrade the SDK-path and AAD-purpose
  // censuses got, for the same reason.
  //
  // The recorder is optional in three distinct spellings, and a detector that knows
  // only the first finds seven of eleven:
  //   constructor param   `private readonly accountAudit: AccountAuditService | null = null`
  //   deps-bag field      `readonly accountAudit?: AccountAuditService`   (PairModeHeartbeatSweep)
  //   inline object type  `accountAudit?: { ... }`                        (SessionsService)
  // Attribution is to the OWNING declaration, not the file: a first draft keyed by
  // file reported 13, because `AuthFlowError` and `WebhooksAdminService` merely share
  // a file with a real consumer. An over-reporting census is not a safe default here
  // — it would demand table entries for classes that take no recorder at all.
  function auditFailOpenConsumers(): Map<string, string> {
    const optional = /\baccountAudit\w*\s*(?:\?\s*:|:[^;,)\n]*\|\s*null)/g;
    const decl = /(?:^|\n)export (class|interface|type) ([A-Za-z_$][\w$]*)/g;
    const out = new Map<string, string>();
    for (const file of sourceFiles) {
      const src = stripComments(readFileSync(file, 'utf8'));
      if (!new RegExp(optional.source).test(src)) continue;
      const decls = [...src.matchAll(decl)].map((m) => {
        const start = m.index ?? 0;
        const open = src.indexOf('{', start);
        return {
          kind: m[1] ?? '',
          name: m[2] ?? '',
          start,
          end: open === -1 ? start : open + balanced(src, open).length + 1,
        };
      });
      for (const hit of src.matchAll(new RegExp(optional.source, 'g'))) {
        const owner = decls.find((d) => d.start <= (hit.index ?? 0) && (hit.index ?? 0) <= d.end);
        if (owner === undefined) continue;
        if (owner.kind === 'class') {
          out.set(owner.name, file);
          continue;
        }
        // A deps bag: the consumer is the class whose constructor takes that type.
        for (const d of decls) {
          if (d.kind !== 'class') continue;
          if (new RegExp(`\\b${owner.name}\\b`).test(src.slice(d.start, d.end)))
            out.set(d.name, file);
        }
      }
    }
    return out;
  }

  it('CRITICAL every service that accepts a fail-open audit recorder is named in AUDIT_WIRED. Without this the table is a list somebody remembered to extend — a new service whose audit emits silently no-op when bootstrap forgets the argument would never be asked about, which is exactly how the four added in V-1441 went unchecked while wired.', () => {
    const derived = auditFailOpenConsumers();
    expect(derived.size, 'the fail-open audit consumer census came back empty').toBeGreaterThan(8);
    const named = new Set(AUDIT_WIRED.map(([service]) => service));
    const unchecked = [...derived.keys()].filter((c) => !named.has(c)).sort();
    expect(
      unchecked,
      'service(s) accepting an optional audit recorder that no arm checks bootstrap wires:',
    ).toEqual([]);
  });

  it('the consumer census attributes to the owning declaration, so the arm above cannot be satisfied by over-reporting. AuthFlowError and WebhooksAdminService each share a file with a real consumer and take no recorder; a file-keyed census names them and would then demand table entries for classes that emit no audit rows at all.', () => {
    const derived = auditFailOpenConsumers();
    expect([...derived.keys()].sort()).not.toContain('AuthFlowError');
    expect([...derived.keys()].sort()).not.toContain('WebhooksAdminService');
    // and it still resolves both non-constructor spellings
    expect([...derived.keys()]).toContain('PairModeHeartbeatSweep'); // deps-bag field
    expect([...derived.keys()]).toContain('SessionsService'); // inline object type
  });

  // V-1435 — the agent-session event bus, where the two ends fail differently.
  //
  // Bootstrap wires the same bus twice, and only one end fails loudly:
  //
  //   AppDeps  (`agentSessionEventBus`)  → app.ts gates SSE route registration on it.
  //                                        Drop it and the route is absent: a 404 the
  //                                        first customer request surfaces.
  //   AgentRuntime (`eventBus:`)         → every publish is `this.deps.eventBus?.publish(...)`.
  //                                        Drop it and the route still registers, still
  //                                        accepts the connection, and never emits.
  //
  // Measured, and the first framing of this needed correcting: with the PUBLISHER
  // wiring removed, 200 tests pass across the bootstrap parity guard, the event
  // bus's own suite, and the agent-sessions integration suite. Removing the
  // SUBSCRIBER wiring is no better caught — the route-census suites build their own
  // app through `buildTestApp` rather than through bootstrap, so a bootstrap change
  // is invisible to them too.
  //
  // So neither end is guarded in CI; they differ only in how visible the RUNTIME
  // failure is. A 404 on the transcript route gets reported. A stream that connects
  // and never emits is indistinguishable from an agent that is simply thinking, for
  // as long as the customer is willing to wait. Both ends are asserted below,
  // because the bus's tests exercise the bus and the route's tests exercise the
  // route — only bootstrap joins them.
  it('CRITICAL bootstrap still passes the event bus into AgentRuntime, the PUBLISHER end. Every publish is optional-chained, so dropping it leaves the SSE transcript route registered and permanently silent rather than absent — the failure a customer cannot tell from a slow agent.', () => {
    const call = /new AgentRuntime\(\{([\s\S]*?)\n {2}\}\)/.exec(bootstrapSource);
    expect(
      call?.[1],
      'the AgentRuntime construction is no longer readable in bootstrap',
    ).toBeDefined();
    expect(
      /\beventBus:\s*\w+/.test(stripComments(call?.[1] ?? '')),
      'bootstrap no longer passes eventBus to AgentRuntime — the transcript stream would connect and never emit',
    ).toBe(true);
  });

  it('CRITICAL bootstrap still passes the event bus into AppDeps, the SUBSCRIBER end. app.ts gates SSE route registration on it, so dropping it removes the transcript route entirely — a louder failure than the publisher end, and equally invisible here, since the route-census suites build their app through buildTestApp rather than bootstrap.', () => {
    const deps = /const deps: AppDeps = \{([\s\S]*?)\n {2}\};/.exec(bootstrapSource);
    expect(deps?.[1], 'the AppDeps assembly is no longer readable in bootstrap').toBeDefined();
    expect(
      /\bagentSessionEventBus\b/.test(stripComments(deps?.[1] ?? '')),
      'bootstrap no longer passes agentSessionEventBus into AppDeps — the SSE transcript route stops registering',
    ).toBe(true);
  });

  // V-1436 — the route-registration seam, derived rather than listed.
  //
  // V-1432..V-1435 each added one arm for one dependency, found one at a time. That
  // is whack-a-mole, and V-1434 showed why it cannot converge: each sweep matched a
  // syntax, and fail-open has more spellings than any one pattern holds.
  //
  // This is the part that CAN be derived with no hand list. `app.ts` gates route
  // registration on a dependency being present — `if (deps.x !== undefined) {
  // registerXRoutes(...) }` — so a dep app.ts gates on and bootstrap never assigns
  // is a route that silently does not exist in production. Both sides come from
  // source, so a new gated route joins the census automatically.
  //
  // Scope, stated rather than implied: this covers the AppDeps seam only. The
  // service-constructor seam — the audit recorder, the live-session guard, the event
  // bus publisher — is not derivable the same way, because "passed to a constructor"
  // carries no marker distinguishing a security dep from a test seam. Those stay as
  // the explicit arms above.
  //
  // It finds nothing today: all 35 gating deps are wired. Recorded because getting
  // there took three corrections of my own extractor — a block-scoped search reported
  // 14 missing, then 3, then 0, because bootstrap assembles AppDeps across several
  // conditional blocks and the identifiers live outside the object literal.
  function routeGatingDeps(): string[] {
    const app = readFileSync(resolve(SRC, 'lib/app.ts'), 'utf8');
    const found = new Set<string>();
    for (const m of app.matchAll(/if \(([^)]{0,400}?)\)\s*\{([\s\S]{0,600}?)\}/g)) {
      if (!/register\w*Routes?\(/.test(m[2] ?? '')) continue;
      for (const d of (m[1] ?? '').matchAll(/deps\.([a-zA-Z]\w*)/g)) found.add(d[1] ?? '');
    }
    return [...found].sort();
  }

  it('CRITICAL the route-gating census found deps on both sides. An extractor that stops matching reports no unwired routes forever — the same empty-list-agrees-with-anything failure the arms above are built to avoid.', () => {
    expect(routeGatingDeps().length, 'no route-gating deps extracted from app.ts').toBeGreaterThan(
      25,
    );
    expect(bootstrapSource.length, 'bootstrap source not readable').toBeGreaterThan(10_000);
  });

  it('CRITICAL every dependency app.ts gates a route on is one bootstrap actually wires. A gated dep bootstrap never assigns is not a disabled feature — it is an endpoint that silently does not exist in production, and no route test can see it because those build their app through the test fixture rather than through bootstrap.', () => {
    const boot = stripComments(bootstrapSource);
    // Property position, in BOTH forms bootstrap uses — a shorthand on its own line
    // (`recipesRepo,`) and an inline conditional spread (`? { billingService }`) —
    // while still excluding the `const recipesRepo = new …` that CONSTRUCTS it.
    //
    // Both narrower drafts were wrong in opposite directions, which is why the
    // comment is here rather than a bare regex: a whole-source word search stayed
    // green when the AppDeps property was deleted (it found the const), and a
    // line-start-only search flagged six deps that are wired through spreads.
    const unwired = routeGatingDeps().filter(
      (d) => !new RegExp(`(?:^|[{,])\\s*${d}\\s*(?=[,:}])`, 'm').test(boot),
    );
    expect(
      unwired,
      'dep(s) app.ts gates route registration on that bootstrap never wires — those routes are absent in production:',
    ).toEqual([]);
  });

  // V-1439 — which R2 bucket Customer Data is routed to.
  //
  // V-1438 proved the two factories target different buckets. This is the other
  // half: that bootstrap hands the PRIVATE client to the consumers that touch
  // Customer Data. The two clients are interchangeable at every call site — same
  // interface, same credentials, one identifier apart — so `r2` → `r2Public` is a
  // one-token edit that compiles, passes every behaviour test (both are an `R2`),
  // and writes sealed profile blobs into the world-readable bucket.
  //
  // Both consumers key on `profileSealedBlobKey`: the profile-save persister writes
  // the blob, and the account-deletion purge sweeper deletes it under the
  // privacy-policy §9 thirty-day erasure commitment. A purge pointed at the wrong
  // bucket would also leave the real blob in place while reporting success.
  //
  // Checked as "private present AND public absent" rather than just the former,
  // because a site holding both would satisfy a presence-only assertion.
  const PRIVATE_R2_CONSUMERS: ReadonlyArray<readonly [site: string, why: string]> = [
    ['makeProfileSavedPersister', 'writes profileSealedBlobKey — sealed Customer Data'],
    ['new AccountDeletionPurgeSweeperService', 'deletes it under the §9 erasure commitment'],
  ];

  it.each(PRIVATE_R2_CONSUMERS)(
    'CRITICAL bootstrap gives %s the PRIVATE R2 client (%s). The two clients share an interface and differ by one identifier, so r2 → r2Public compiles, passes every behaviour test, and routes sealed Customer Data to the world-readable bucket.',
    (site) => {
      // Match the CALL, not the import, and read to the BALANCED close rather than a
      // fixed window. Both drafts of this were wrong: `indexOf(site)` found the
      // import line for one consumer, and a 2200-char window fell short of the
      // other, whose argument list carries a long comment block. The file already
      // had `balanced()` for exactly this.
      const call = new RegExp(`${site.replace(/[.*+?^$}{()|[\]\\]/g, '\\$&')}\\s*\\(`).exec(
        bootstrapSource,
      );
      expect(call, `the ${site} call is no longer present in bootstrap`).not.toBeNull();
      const open = bootstrapSource.indexOf('(', (call?.index ?? 0) + site.length - 1);
      const args = stripComments(balanced(bootstrapSource, open));
      expect(args.length, `the ${site} argument list read as empty`).toBeGreaterThan(0);
      expect(/\br2\b/.test(args), `${site} no longer receives the private r2 client`).toBe(true);
      expect(
        /\br2Public\b/.test(args),
        `${site} now receives r2Public — sealed Customer Data would be written to the public bucket`,
      ).toBe(false);
    },
  );
});
