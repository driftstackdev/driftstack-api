// W423.C (W670-deepened) — drift guard for packages/sdk-typescript/
// src/client.ts. Driftstack single-entry-point composition.
//
// W670 splits the original 9 it() blocks into 16 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • 15-resource roster pinned PER RESOURCE — drift to dropping any
//     resource accessor would silently make `client.<name>` undefined
//     at runtime AND remove the resource from the type system.
//   • V-cluster JSDoc framings pinned per-resource — V-312
//     profileSnapshots, V-666 cryptoOrders, V-353b mfa pairs-with-
//     auth.mfaChallenge/mfaStepUp, V-216 auditLog, V-204 email
//     preferences, V-049 legal, V-298c/d team. Drift to dropping
//     any V-anchor would lose changelog provenance.
//   • DEFAULT_BASE_URL = 'https://api.driftstack.dev' pinned per-
//     line. Drift to a different default would silently route
//     production traffic elsewhere.
//   • apiKey TypeError guard — explicit type-check + descriptive
//     error message. Drift to a generic Error or silent-pass on
//     non-string would let customers debug "why is auth failing"
//     instead of seeing the TypeError early.
//   • baseUrl trailing-slash normalization — `/\/+$/` regex strips
//     ALL trailing slashes (not just one). Drift to single-slash
//     strip would let `https://api.driftstack.dev//` produce
//     `https://api.driftstack.dev/` (still trailing). Drift to
//     stripping ALL slashes (no anchor) would mangle the scheme.
//   • Conditional config spread on retry / timeoutMs / fetch —
//     `!== undefined ? { key: opts.key } : {}` keeps
//     undefined-vs-missing-key distinction.
//   • private readonly http — encapsulated; not exposed publicly.
//     Drift to public would let customers mutate the HTTP client.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/client.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W423.C packages/sdk-typescript/src/client.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module header pinned (single entry point + composes resources + HTTP layer + resource accessors example)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ Driftstack client — single entry point\. Composes the resources and the\s*\n?\s*\/\/ HTTP layer\. Customers instantiate one of these and use the resource\s*\n?\s*\/\/ accessors \(`client\.sessions`, `client\.apiKeys`, `client\.usage`\)\./,
    );
  });

  it('Imports — HttpClient + HttpClientConfig type from ./http.js (.js ESM-compat suffix). Drift to dropping HttpClientConfig type-import would force inline typing in the constructor + lose type-checking on the config builder.', () => {
    expect(body).toMatch(/import \{ HttpClient, type HttpClientConfig \} from '\.\/http\.js';/);
  });

  it('Imports — 15 resource classes (sessions / api-keys / usage / webhooks / profiles / profile-snapshots / billing / crypto-orders / auth / account / audit-log / email-preferences / legal / mfa / team). CRITICAL: every resource MUST be imported here OR the client field is undefined at runtime. Drift to dropping any import would silently make `client.<name>` undefined.', () => {
    expect(body).toMatch(/import \{ SessionsResource \} from '\.\/resources\/sessions\.js';/);
    expect(body).toMatch(/import \{ ApiKeysResource \} from '\.\/resources\/api-keys\.js';/);
    expect(body).toMatch(/import \{ UsageResource \} from '\.\/resources\/usage\.js';/);
    expect(body).toMatch(/import \{ WebhooksResource \} from '\.\/resources\/webhooks\.js';/);
    expect(body).toMatch(/import \{ ProfilesResource \} from '\.\/resources\/profiles\.js';/);
    expect(body).toMatch(
      /import \{ ProfileSnapshotsResource \} from '\.\/resources\/profile-snapshots\.js';/,
    );
    expect(body).toMatch(/import \{ BillingResource \} from '\.\/resources\/billing\.js';/);
    expect(body).toMatch(
      /import \{ CryptoOrdersResource \} from '\.\/resources\/crypto-orders\.js';/,
    );
    expect(body).toMatch(/import \{ AuthResource \} from '\.\/resources\/auth\.js';/);
    expect(body).toMatch(/import \{ AccountResource \} from '\.\/resources\/account\.js';/);
    expect(body).toMatch(/import \{ AuditLogResource \} from '\.\/resources\/audit-log\.js';/);
    expect(body).toMatch(
      /import \{ EmailPreferencesResource \} from '\.\/resources\/email-preferences\.js';/,
    );
    expect(body).toMatch(/import \{ LegalResource \} from '\.\/resources\/legal\.js';/);
    expect(body).toMatch(/import \{ MfaResource \} from '\.\/resources\/mfa\.js';/);
    expect(body).toMatch(/import \{ TeamResource \} from '\.\/resources\/team\.js';/);
    expect(body).toMatch(/import type \{ RetryConfig \} from '\.\/retry\.js';/);
  });

  it('DriftstackOptions interface — 6-field shape (apiKey required + baseUrl/retry/effectiveAccount/timeoutMs/fetch optional). CRITICAL: apiKey JSDoc pins the `ds_live_…` / `ds_test_…` prefix convention; timeoutMs default 30000 pinned; fetch test-seam rationale pinned; effectiveAccount = the V-326c team-workspace header option (admin-for-writes server-enforced).', () => {
    expect(body).toMatch(/export interface DriftstackOptions \{/);
    expect(body).toContain('/** Long-lived API key (`ds_live_…` or `ds_test_…`). */');
    expect(body).toContain('apiKey: string;');
    expect(body).toContain("/** API base URL. Defaults to the production URL once it's live. */");
    expect(body).toContain('baseUrl?: string;');
    expect(body).toContain('/** Per-request retry configuration. */');
    expect(body).toContain('retry?: RetryConfig;');
    expect(body).toContain('effectiveAccount?: string;');
    expect(body).toMatch(/Sends `X-Driftstack-Account` on every request/);
    expect(body).toContain('/** Per-request timeout in ms. Default 30000. */');
    expect(body).toContain('timeoutMs?: number;');
    expect(body).toContain(
      '/** Override the global fetch implementation (test seams, polyfills). */',
    );
    expect(body).toContain('fetch?: typeof fetch;');
  });

  it('CRITICAL DEFAULT_BASE_URL constant — `https://api.driftstack.dev` (production URL, no trailing slash). Drift to a different domain would silently route production traffic elsewhere; drift to including a trailing slash would interact with the trailing-slash strip regex to double-modify.', () => {
    expect(body).toMatch(/const DEFAULT_BASE_URL = 'https:\/\/api\.driftstack\.dev';/);
  });

  it("Driftstack class — 15 readonly resource fields. Resources that don't need V-cluster JSDoc framing (sessions/apiKeys/usage/webhooks/profiles/billing/auth/account) pinned as bare `readonly <name>: <Resource>;` declarations.", () => {
    expect(body).toMatch(/readonly sessions: SessionsResource;/);
    expect(body).toMatch(/readonly apiKeys: ApiKeysResource;/);
    expect(body).toMatch(/readonly usage: UsageResource;/);
    expect(body).toMatch(/readonly webhooks: WebhooksResource;/);
    expect(body).toMatch(/readonly profiles: ProfilesResource;/);
    expect(body).toMatch(/readonly billing: BillingResource;/);
    expect(body).toMatch(/readonly auth: AuthResource;/);
    expect(body).toMatch(/readonly account: AccountResource;/);
  });

  it('V-cluster JSDoc framings — 7 resource fields carry inline V-anchors: V-312 profileSnapshots + V-666 cryptoOrders + V-353b mfa pairs-with-auth.mfaChallenge/mfaStepUp + V-216 auditLog + V-204 emailPreferences + V-049 legal + V-298c team (auth-integration is V-298d). Drift to dropping any V-anchor would lose the changelog provenance for that resource.', () => {
    expect(body).toMatch(
      /\/\*\* V-312 — immutable point-in-time profile snapshots\. \*\/\s*\n?\s*readonly profileSnapshots: ProfileSnapshotsResource;/,
    );
    expect(body).toMatch(
      /\/\*\* V-666 — crypto-payment orders \(customer surface\)\. \*\/\s*\n?\s*readonly cryptoOrders: CryptoOrdersResource;/,
    );
    expect(body).toMatch(
      /\/\*\* V-353b — MFA enrollment management\. Pairs with `auth\.mfaChallenge` \+ `auth\.mfaStepUp`\. \*\/\s*\n?\s*readonly mfa: MfaResource;/,
    );
    expect(body).toMatch(
      /\/\*\* V-216 — append-only customer audit log read \+ iterate\. \*\/\s*\n?\s*readonly auditLog: AuditLogResource;/,
    );
    expect(body).toMatch(
      /\/\*\* V-204 — non-critical email opt-in\/opt-out preferences\. \*\/\s*\n?\s*readonly emailPreferences: EmailPreferencesResource;/,
    );
    expect(body).toMatch(
      /\/\*\* V-049 — legal-document acceptance machinery\. \*\/\s*\n?\s*readonly legal: LegalResource;/,
    );
    expect(body).toMatch(
      /\/\*\* V-298c — Team RBAC\. Auth path integration is V-298d\. \*\/\s*\n?\s*readonly team: TeamResource;/,
    );
  });

  it('private readonly http: HttpClient — encapsulated, NOT exposed publicly. CRITICAL: drift to public would let customers mutate the HTTP client (e.g. swap retry config mid-flight) which would surprise resource-level callers that assume stable config. The private+readonly combo is the load-bearing access-control claim.', () => {
    expect(body).toMatch(/private readonly http: HttpClient;/);
  });

  it('CRITICAL apiKey TypeError guard — `if (!opts.apiKey || typeof opts.apiKey !== \'string\')` early-throw with descriptive message "Driftstack: apiKey is required and must be a string". Drift to a generic Error would lose the "Driftstack:" prefix that lets customers grep their logs; drift to silent-pass would let customers debug "why is auth failing" instead of seeing the TypeError at construction.', () => {
    expect(body).toMatch(
      /constructor\(opts: DriftstackOptions\) \{\s*\n?\s*if \(!opts\.apiKey \|\| typeof opts\.apiKey !== 'string'\) \{\s*\n?\s*throw new TypeError\('Driftstack: apiKey is required and must be a string'\);\s*\n?\s*\}/,
    );
  });

  it("CRITICAL baseUrl trailing-slash normalization — `(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\\/+$/, '')`. The `\\/+$` regex matches ONE OR MORE trailing slashes (the `+` quantifier) so `https://api.driftstack.dev//` becomes `https://api.driftstack.dev`. Drift to single-slash strip would let double-slashes through; drift to dropping the `$` anchor would mangle the scheme (`https://` would lose its slashes).", () => {
    expect(body).toMatch(
      /const httpConfig: HttpClientConfig = \{\s*\n?\s*apiKey: opts\.apiKey,\s*\n?\s*baseUrl: \(opts\.baseUrl \?\? DEFAULT_BASE_URL\)\.replace\(\/\\\/\+\$\/, ''\),/,
    );
  });

  it('Conditional config spread invariants — retry / timeoutMs / fetch all use `!== undefined ? { key: opts.key } : {}` pattern. CRITICAL: keeps the undefined-vs-missing-key distinction so HttpClient sees `{}` (no key) instead of `{ retry: undefined }` (key with undefined value). Drift to always-spread would silently nullify retry config in HttpClient.', () => {
    expect(body).toMatch(/\.\.\.\(opts\.retry !== undefined \? \{ retry: opts\.retry \} : \{\}\),/);
    expect(body).toMatch(
      /\.\.\.\(opts\.timeoutMs !== undefined \? \{ timeoutMs: opts\.timeoutMs \} : \{\}\),/,
    );
    expect(body).toMatch(/\.\.\.\(opts\.fetch !== undefined \? \{ fetch: opts\.fetch \} : \{\}\),/);
  });

  it('HttpClient instantiation — `this.http = new HttpClient(httpConfig);` ONCE in the constructor. CRITICAL: every resource gets the SAME HttpClient instance (drift to per-resource HttpClient instances would let retry/timeout config drift between resources + multiply network connections).', () => {
    expect(body).toMatch(/this\.http = new HttpClient\(httpConfig\);/);
  });

  it('Resource instantiation — every public resource gets the SAME HttpClient instance. Drift to dropping any line would let `client.<name>` be undefined at runtime even if the field declaration exists.', () => {
    expect(body).toMatch(/this\.archetypes = new ArchetypesResource\(this\.http\);/);
    expect(body).toMatch(/this\.sessions = new SessionsResource\(this\.http\);/);
    expect(body).toMatch(/this\.apiKeys = new ApiKeysResource\(this\.http\);/);
    expect(body).toMatch(/this\.usage = new UsageResource\(this\.http\);/);
    expect(body).toMatch(/this\.webhooks = new WebhooksResource\(this\.http\);/);
    expect(body).toMatch(/this\.profiles = new ProfilesResource\(this\.http\);/);
    expect(body).toMatch(/this\.profileSnapshots = new ProfileSnapshotsResource\(this\.http\);/);
    expect(body).toMatch(/this\.billing = new BillingResource\(this\.http\);/);
    expect(body).toMatch(/this\.cryptoOrders = new CryptoOrdersResource\(this\.http\);/);
    expect(body).toMatch(/this\.auth = new AuthResource\(this\.http\);/);
    expect(body).toMatch(/this\.account = new AccountResource\(this\.http\);/);
    expect(body).toMatch(/this\.mfa = new MfaResource\(this\.http\);/);
    expect(body).toMatch(/this\.auditLog = new AuditLogResource\(this\.http\);/);
    expect(body).toMatch(/this\.emailPreferences = new EmailPreferencesResource\(this\.http\);/);
    expect(body).toMatch(/this\.legal = new LegalResource\(this\.http\);/);
    expect(body).toMatch(/this\.team = new TeamResource\(this\.http\);/);
  });

  it('19-resource count drift guard — includes public archetype discovery alongside egress, agent sessions and recipes', () => {
    const readonlyFields = (body.match(/^ {2}readonly [a-zA-Z]+: [A-Za-z]+Resource;$/gm) ?? [])
      .length;
    expect(readonlyFields, 'expected 19 readonly resource fields').toBe(19);
    const instantiations = (
      body.match(/this\.[a-zA-Z]+ = new [A-Za-z]+Resource\(this\.http\);/g) ?? []
    ).length;
    expect(instantiations, 'expected 19 resource instantiations').toBe(19);
  });

  it('Cross-SDK core resource-name invariant includes public archetype discovery and the established customer resources', () => {
    const fieldNames = [
      'archetypes',
      'sessions',
      'apiKeys',
      'usage',
      'webhooks',
      'profiles',
      'profileSnapshots',
      'billing',
      'cryptoOrders',
      'auth',
      'account',
      'mfa',
      'auditLog',
      'emailPreferences',
      'legal',
      'team',
    ];
    for (const f of fieldNames) {
      expect(body).toMatch(new RegExp(`readonly ${f}:`));
      expect(body).toMatch(new RegExp(`this\\.${f} =`));
    }
  });
});
