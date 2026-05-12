// W423.C — drift guard for packages/sdk-typescript/src/client.ts.
// Single entry point that composes the resources + HTTP layer.
// Drift here either drops a resource (consumer's client.<name> goes
// undefined) or breaks the baseUrl normalization (trailing-slash
// double-pathing).
//
//   • Framing pinned: single entry point; composes resources +
//     HttpClient; one Driftstack() per app.
//   • Resource roster pinned: 15 resources with V-cluster framings
//     for the post-V-440 additions (profileSnapshots V-312,
//     cryptoOrders V-666, mfa V-353b, auditLog V-216,
//     emailPreferences V-204, legal V-049, team V-298c).
//   • DEFAULT_BASE_URL = https://api.driftstack.dev.
//   • apiKey guard: throws TypeError on missing/non-string.
//   • baseUrl normalization: trailing slashes stripped via
//     /\/+$/.

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

  it('Framing pinned: single entry point; composes resources + HTTP layer; resource accessors (sessions/apiKeys/usage)', () => {
    expect(body).toMatch(
      /\/\/ Driftstack client — single entry point\. Composes the resources and the\s*\n?\s*\/\/ HTTP layer\. Customers instantiate one of these and use the resource\s*\n?\s*\/\/ accessors \(`client\.sessions`, `client\.apiKeys`, `client\.usage`\)\./,
    );
  });

  it('imports: HttpClient + 15 resources + RetryConfig type', () => {
    expect(body).toMatch(/import \{ HttpClient, type HttpClientConfig \} from '\.\/http\.js';/);
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

  it('DriftstackOptions interface: apiKey (ds_live_…/ds_test_…) + baseUrl + retry + timeoutMs (default 30000) + fetch override', () => {
    expect(body).toMatch(
      /export interface DriftstackOptions \{\s*\n?\s*\/\*\* Long-lived API key \(`ds_live_…` or `ds_test_…`\)\. \*\/\s*\n?\s*apiKey: string;\s*\n?\s*\/\*\* API base URL\. Defaults to the production URL once it's live\. \*\/\s*\n?\s*baseUrl\?: string;\s*\n?\s*\/\*\* Per-request retry configuration\. \*\/\s*\n?\s*retry\?: RetryConfig;\s*\n?\s*\/\*\* Per-request timeout in ms\. Default 30000\. \*\/\s*\n?\s*timeoutMs\?: number;\s*\n?\s*\/\*\* Override the global fetch implementation \(test seams, polyfills\)\. \*\/\s*\n?\s*fetch\?: typeof fetch;\s*\n?\s*\}/,
    );
  });

  it("DEFAULT_BASE_URL = 'https://api.driftstack.dev'", () => {
    expect(body).toMatch(/const DEFAULT_BASE_URL = 'https:\/\/api\.driftstack\.dev';/);
  });

  it('Resource roster pinned: 15 resources with V-cluster framings (V-312/V-666/V-353b/V-216/V-204/V-049/V-298c)', () => {
    expect(body).toMatch(/readonly sessions: SessionsResource;/);
    expect(body).toMatch(/readonly apiKeys: ApiKeysResource;/);
    expect(body).toMatch(/readonly usage: UsageResource;/);
    expect(body).toMatch(/readonly webhooks: WebhooksResource;/);
    expect(body).toMatch(/readonly profiles: ProfilesResource;/);
    expect(body).toMatch(
      /\/\*\* V-312 — immutable point-in-time profile snapshots\. \*\/\s*\n?\s*readonly profileSnapshots: ProfileSnapshotsResource;/,
    );
    expect(body).toMatch(/readonly billing: BillingResource;/);
    expect(body).toMatch(
      /\/\*\* V-666 — crypto-payment orders \(customer surface\)\. \*\/\s*\n?\s*readonly cryptoOrders: CryptoOrdersResource;/,
    );
    expect(body).toMatch(/readonly auth: AuthResource;/);
    expect(body).toMatch(/readonly account: AccountResource;/);
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

  it('Constructor: apiKey type-check (TypeError on missing/non-string) + baseUrl trailing-slash strip + each resource constructed with this.http', () => {
    expect(body).toMatch(
      /constructor\(opts: DriftstackOptions\) \{\s*\n?\s*if \(!opts\.apiKey \|\| typeof opts\.apiKey !== 'string'\) \{\s*\n?\s*throw new TypeError\('Driftstack: apiKey is required and must be a string'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const httpConfig: HttpClientConfig = \{\s*\n?\s*apiKey: opts\.apiKey,\s*\n?\s*baseUrl: \(opts\.baseUrl \?\? DEFAULT_BASE_URL\)\.replace\(\/\\\/\+\$\/, ''\),/,
    );
    expect(body).toMatch(/this\.http = new HttpClient\(httpConfig\);/);
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

  it('httpConfig spread guards (conditional include only when defined): retry / timeoutMs / fetch — keeps undefined-vs-missing-key distinction', () => {
    expect(body).toMatch(/\.\.\.\(opts\.retry !== undefined \? \{ retry: opts\.retry \} : \{\}\),/);
    expect(body).toMatch(
      /\.\.\.\(opts\.timeoutMs !== undefined \? \{ timeoutMs: opts\.timeoutMs \} : \{\}\),/,
    );
    expect(body).toMatch(/\.\.\.\(opts\.fetch !== undefined \? \{ fetch: opts\.fetch \} : \{\}\),/);
  });

  it('private http: HttpClient (encapsulated — not exposed publicly)', () => {
    expect(body).toMatch(/private readonly http: HttpClient;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
