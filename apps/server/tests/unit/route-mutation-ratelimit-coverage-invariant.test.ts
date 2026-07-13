// Mutation-route rate-limit coverage invariant (drift-guard).
//
// Pins the security property verified manually in the 2026-06-02
// per-route abuse-coverage audit (auto-memory
// project_ratelimit_route_coverage_clean): EVERY customer-facing
// mutation route (POST/PUT/PATCH/DELETE in apps/server/src/routes)
// carries an abuse limiter, via one of four protection classes:
//
//   1. limiter      — `app.rateLimit(...)` (authed customer routes) OR
//                     `ipRateLimit(...)` / a file-local `ipRateLimit`
//                     gate const (the unauth auth/oauth/status gates) OR
//                     the internal `requireInternalAuth` preHandler,
//                     which bearer-auths AND self-rate-limits via
//                     rateLimitStore.consume() (internal-fleet-auth audit).
//   2. admin        — `requireScope('driftstack_internal_admin')`
//                     (internal-staff-only; flooding one's own admin API
//                     is self-inflicted, not a public abuse vector).
//   3. gated stub   — a 2-arg `app.method('/path', stubHandler)` form
//                     registered by the activation-gate OFF branch; it
//                     returns 503 FeatureUnavailable immediately, so it
//                     is not an abuse surface (the LIVE branch's real
//                     route carries a limiter, and is checked here).
//   4. exempt       — an explicit, justified allowlist: the HMAC-signature-
//                     verified webhook-ingress routes + the V-266 public
//                     cli-authorize routes with their dedicated IP gates.
//
// A mutation route in none of these classes is a wide-open abuse surface.
// Before this guard the property was only manually verified each audit
// wave; now a newly-added unprotected route fails CI with a precise
// message telling the author to add a limiter or justify an exemption.
//
// Surfaced as backlog item §4.3 in
// docs/internal/2026-06-02-resilience-arc-and-founder-decision-queue.md.
//
// The scanner never descends into handler bodies (which contain arbitrary
// strings/comments/regex): each declaration's analysis is bounded to the
// text between its own `app.method(` and the next route declaration, and
// the "guard region" ends at the handler boundary (`=>` / `function`), so
// only the path + options object is ever inspected.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

const MUTATION_METHODS = new Set(['post', 'put', 'patch', 'delete']);

// Protection class 4 — BY DESIGN: routes that intentionally carry no
// limiter for a sound, settled reason.
const EXEMPT_BY_DESIGN: ReadonlyArray<{ file: string; path: string; reason: string }> = [
  {
    file: 'webhooks-stripe.ts',
    path: '/v1/webhooks/stripe',
    reason:
      'HMAC signature-verified in-handler + Cloudflare-fronted; no IP limiter so legit Stripe deliveries (varying source IPs) are not blocked, bogus payloads cheap-rejected by the sig check + bodyLimit.',
  },
  {
    file: 'webhooks-nowpayments.ts',
    path: '/v1/webhooks/nowpayments',
    reason: 'NowPayments IPN — same signature-verified-ingress rationale as the Stripe webhook.',
  },
];

const EXEMPT = EXEMPT_BY_DESIGN;

// Bespoke preHandler that authenticates AND self-rate-limits
// (rateLimitStore.consume) — treated as a limiter (project_internal_fleet_auth_audit_clean).
const INTERNAL_LIMITER_IDENTS = ['requireInternalAuth'];

interface RouteDecl {
  file: string;
  method: string;
  path: string;
  guardRegion: string;
  isStub: boolean;
}

const DECL_RE = /\bapp\.(get|post|put|patch|delete|head|options)\s*\(/g;

/** Read the first single/double/backtick string literal starting at `from`. */
function readLeadingString(s: string, from: number): { value: string; end: number } | null {
  let i = from;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  const q = s[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let out = '';
  i++;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === q) return { value: out, end: i + 1 };
    out += c;
  }
  return null;
}

function scanFile(file: string, src: string): RouteDecl[] {
  // File-local `const X = ipRateLimit(...)` gate identifiers.
  const gateIdents = new Set<string>(INTERNAL_LIMITER_IDENTS);
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ipRateLimit\s*\(/g,
  )) {
    gateIdents.add(m[1]!);
  }

  // Locate every route declaration so each one's region can be bounded by
  // the next declaration (never bleeding into a handler body).
  const decls: Array<{ method: string; openParen: number }> = [];
  DECL_RE.lastIndex = 0;
  for (let m = DECL_RE.exec(src); m !== null; m = DECL_RE.exec(src)) {
    decls.push({ method: m[1]!.toLowerCase(), openParen: DECL_RE.lastIndex });
  }

  const out: RouteDecl[] = [];
  for (let k = 0; k < decls.length; k++) {
    const { method, openParen } = decls[k]!;
    if (!MUTATION_METHODS.has(method)) continue;
    const regionEnd = k + 1 < decls.length ? decls[k + 1]!.openParen : src.length;

    const pathLit = readLeadingString(src, openParen);
    if (!pathLit || !pathLit.value.startsWith('/')) continue; // not a route registration
    const afterPath = pathLit.end;

    // Guard region = text from after the path up to the handler boundary
    // (`=>` for arrow handlers, `function` for function handlers), bounded
    // by the next declaration. Options/preHandler live entirely in here;
    // the handler body never does.
    const regionText = src.slice(afterPath, regionEnd);
    const arrowIdx = regionText.indexOf('=>');
    const funcIdx = regionText.search(/\bfunction\b/);
    const bounds = [arrowIdx, funcIdx].filter((x) => x >= 0);
    const handlerStart = bounds.length ? Math.min(...bounds) : -1;

    const guardRegion = handlerStart >= 0 ? regionText.slice(0, handlerStart) : regionText;
    // Stub = 2-arg form, bare-identifier handler, no inline function.
    const isStub = handlerStart < 0 && /^\s*,\s*[A-Za-z_$][\w$]*\s*\)/.test(regionText);

    out.push({ file, method, path: pathLit.value, guardRegion, isStub });
  }
  return out;
}

function hasLimiter(guard: string, gateIdents: Set<string>): boolean {
  if (/\b(?:rateLimit|ipRateLimit)\s*\(/.test(guard)) return true;
  for (const id of gateIdents) {
    if (new RegExp(`\\b${id}\\b`).test(guard)) return true;
  }
  return false;
}

function hasAdminScope(guard: string): boolean {
  return /requireScope\s*\(\s*['"]driftstack_internal_admin['"]\s*\)/.test(guard);
}

describe('mutation-route rate-limit coverage invariant', () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  const allRoutes: RouteDecl[] = [];
  const fileGateIdents = new Map<string, Set<string>>();
  for (const f of files) {
    const src = readFileSync(resolve(ROUTES_DIR, f), 'utf8');
    const gateIdents = new Set<string>(INTERNAL_LIMITER_IDENTS);
    for (const m of src.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ipRateLimit\s*\(/g,
    )) {
      gateIdents.add(m[1]!);
    }
    fileGateIdents.set(f, gateIdents);
    allRoutes.push(...scanFile(f, src));
  }

  const isExempt = (r: RouteDecl): boolean =>
    EXEMPT.some((e) => e.file === r.file && e.path === r.path);

  it('finds the mutation-route surface (scanner non-vacuity)', () => {
    // Guards against a registration-style refactor silently making the
    // scanner match ~0 routes (a vacuous pass). The 2026-06-02 audit
    // counted 79; allow generous drift but catch "found nothing".
    expect(allRoutes.length).toBeGreaterThan(50);
  });

  it('every mutation route carries an abuse limiter, admin scope, is a gated stub, or is explicitly exempt', () => {
    const violations = allRoutes
      .filter((r) => {
        if (r.isStub) return false;
        if (isExempt(r)) return false;
        const gateIdents = fileGateIdents.get(r.file)!;
        if (hasLimiter(r.guardRegion, gateIdents)) return false;
        if (hasAdminScope(r.guardRegion)) return false;
        return true;
      })
      .map((r) => `${r.method.toUpperCase()} ${r.path} (${r.file})`);

    expect(
      violations,
      `Unprotected mutation route(s) found — add app.rateLimit('global') / an ipRateLimit gate ` +
        `to the preHandler, or (if intentionally public) add a justified entry to EXEMPT in this ` +
        `test in the same commit:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every EXEMPT allowlist entry still resolves to a real route (no rot)', () => {
    const stale = EXEMPT.filter(
      (e) => !allRoutes.some((r) => r.file === e.file && r.path === e.path),
    ).map((e) => `${e.path} (${e.file})`);
    expect(
      stale,
      `Stale EXEMPT entries (route no longer exists) — remove them:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
