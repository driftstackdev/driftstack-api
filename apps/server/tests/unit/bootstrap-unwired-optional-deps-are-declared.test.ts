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
  ];

  it.each(AUDIT_WIRED)(
    'CRITICAL bootstrap still passes the audit recorder into %s (%s). The parameter is optional and every emit fails OPEN, so a dropped argument silently stops writing customer audit rows — tsc accepts it and the behaviour tests cannot see it.',
    (service) => {
      const call = new RegExp(
        `new ${service}\\(([\\s\\S]*?)\\n {2}\\)|new ${service}\\(([^;]*?)\\);`,
      ).exec(bootstrapSource);
      expect(call, `the ${service} construction is no longer readable in bootstrap`).not.toBeNull();
      const args = stripComments(`${call?.[1] ?? ''}${call?.[2] ?? ''}`);
      expect(
        /\baccountAudit(?:Service)?\b/.test(args),
        `bootstrap no longer passes the audit recorder to ${service} — its audit emits are fail-open and now write nothing`,
      ).toBe(true);
    },
  );
});
