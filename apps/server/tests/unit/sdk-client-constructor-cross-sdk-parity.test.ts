// W819 — cross-SDK client constructor parity. One-hundred-forty-
// fifth in the drift-guard series. Pins the top-level entry-point
// (Driftstack/Driftstack/Client) shape across all 3 SDKs. Drift in
// the required resource accessors would silently break customer code
// that depends on `client.sessions`, `client.billing`, etc.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/client.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/client.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/client.go');

// Required resource accessors. Each must exist as a field/property
// on the top-level client in all 3 SDKs. Drift to dropping any would
// orphan a documented surface area. Adding a new resource = cross-SDK
// lift (all 3 SDKs land in the same commit); count grows in lockstep.
//
// V-1093: the roster is also the population, so for as long as a resource was
// missing from it nothing here could say so. `archetypes` was on all three
// clients and absent from this list, which meant deleting it from the
// TypeScript or Python client left every arm below green. The completeness arm
// at the end of this file derives the surface from the Go client struct and
// requires each member to appear here, so the roster can no longer sit behind
// the thing it is meant to guard. The three naming conventions still need a
// hand-written mapping — Go `APIKeys`, TS `apiKeys`, Python `api_keys` is not
// derivable by rule — but which resources exist is not a judgement call.
const REQUIRED_RESOURCES = [
  ['sessions', 'SessionsResource', 'Sessions'],
  ['archetypes', 'ArchetypesResource', 'Archetypes'],
  ['apiKeys', 'ApiKeysResource', 'APIKeys'],
  ['usage', 'UsageResource', 'Usage'],
  ['webhooks', 'WebhooksResource', 'Webhooks'],
  ['profiles', 'ProfilesResource', 'Profiles'],
  ['profileSnapshots', 'ProfileSnapshotsResource', 'ProfileSnapshots'],
  ['billing', 'BillingResource', 'Billing'],
  ['cryptoOrders', 'CryptoOrdersResource', 'CryptoOrders'],
  ['auth', 'AuthResource', 'Auth'],
  ['account', 'AccountResource', 'Account'],
  ['mfa', 'MfaResource', 'Mfa'],
  ['auditLog', 'AuditLogResource', 'AuditLog'],
  ['emailPreferences', 'EmailPreferencesResource', 'EmailPreferences'],
  ['legal', 'LegalResource', 'Legal'],
  ['team', 'TeamResource', 'Team'],
  ['egress', 'EgressResource', 'Egress'],
  ['agentSessions', 'AgentSessionsResource', 'AgentSessions'],
  ['recipes', 'RecipesResource', 'Recipes'],
] as const;

describe('W819 cross-SDK client constructor parity', () => {
  it('all 3 client implementations exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── DEFAULT_BASE_URL constant ────────────────────────────────

  it("CRITICAL all 3 SDKs declare DEFAULT_BASE_URL = 'https://api.driftstack.dev' as a top-level constant. Drift to a different default host would silently point every customer at the wrong API.", () => {
    expect(read(TS)).toMatch(/const DEFAULT_BASE_URL = 'https:\/\/api\.driftstack\.dev';/);
    expect(read(PY)).toMatch(/^DEFAULT_BASE_URL = "https:\/\/api\.driftstack\.dev"$/m);
    expect(read(GO)).toMatch(/const DefaultBaseURL = "https:\/\/api\.driftstack\.dev"/);
  });

  // ─── DEFAULT_TIMEOUT 30s ──────────────────────────────────────

  it('CRITICAL TS + Go declare a default 30-second per-request timeout. TS: timeoutMs defaults to 30000 (docstring: "Default 30000"). Go: DefaultTimeout = 30 * time.Second. Drift to a different timeout would change client-vs-server SLA assumptions.', () => {
    expect(read(TS)).toMatch(/Default 30000/);
    expect(read(GO)).toMatch(/const DefaultTimeout = 30 \* time\.Second/);
  });

  // ─── Top-level client class names ─────────────────────────────

  it("CRITICAL each SDK exports the canonical top-level entry — TS: 'export class Driftstack' + Python: dual 'Driftstack' + 'AsyncDriftstack' + Go: 'type Client struct'. Drift to renaming would break every customer import.", () => {
    expect(read(TS)).toMatch(/^export class Driftstack \{/m);
    // Python has both sync + async classes.
    expect(read(PY)).toMatch(/\bclass Driftstack\b/);
    expect(read(PY)).toMatch(/\bclass AsyncDriftstack\b/);
    expect(read(GO)).toMatch(/^type Client struct \{/m);
  });

  // ─── 15-required-resource-accessor set ────────────────────────

  it('CRITICAL every required resource accessor exists on each SDK client. Drift to dropping any would orphan a documented customer surface. Wave 1119: EGRESS (egress, all 3 SDKs at commit b4c27598) + AI-CHAT (agentSessions, all 3 SDKs at the AI-D slice) + AI-B4 RECIPES (recipes, all 3 SDKs at this Q.5.d cross-SDK lift). V-1093: the title stated a roster size, which was accurate about the list and silent about the surface — the list was a resource short of what the clients carry, and a stated size reads as coverage.', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, tsClass, goName] of REQUIRED_RESOURCES) {
      // TS uses camelCase field names + ResourceXxx classes.
      expect(ts, `TS missing 'readonly ${tsName}: ${tsClass}'`).toMatch(
        new RegExp(`readonly ${tsName}: ${tsClass};`),
      );
      // Go uses PascalCase field names.
      expect(go, `Go missing '${goName} *.*Resource'`).toMatch(
        new RegExp(`\\b${goName}\\s+\\*\\w*Resource\\b`),
      );
      // Python imports the AsyncXxxResource + XxxResource pair.
      // Skip apiKeys (Python uses snake_case: api_keys) — handled separately below.
    }
    // Python's 18-resource sync + async dual import set.
    expect(py).toMatch(
      /from driftstack\.resources\.sessions import AsyncSessionsResource, SessionsResource/,
    );
    expect(py).toMatch(
      /from driftstack\.resources\.billing import AsyncBillingResource, BillingResource/,
    );
    expect(py).toMatch(
      /from driftstack\.resources\.egress import AsyncEgressResource, EgressResource/,
    );
    expect(py).toMatch(
      /from driftstack\.resources\.agent_sessions import\s+\(\s+AgentSessionsResource,\s+AsyncAgentSessionsResource,\s+\)/,
    );
  });

  // ─── V-anchor framing inline in TS client ─────────────────────

  it('CRITICAL TS client docstrings thread V-NNN provenance to each resource. V-312 (profileSnapshots) + V-666 (cryptoOrders) + V-353b (mfa) + V-216 (auditLog) + V-204 (emailPreferences) + V-049 (legal) + V-298c (team). Drift to dropping the V-anchors would lose teaching cross-links.', () => {
    const p = read(TS);
    expect(p).toMatch(/V-312 — immutable point-in-time profile snapshots/);
    expect(p).toMatch(/V-666 — crypto-payment orders \(customer surface\)/);
    expect(p).toMatch(/V-353b — MFA enrollment management/);
    expect(p).toMatch(/V-216 — append-only customer audit log/);
    expect(p).toMatch(/V-204 — non-critical email opt-in\/opt-out preferences/);
    expect(p).toMatch(/V-049 — legal-document acceptance machinery/);
    expect(p).toMatch(/V-298c — Team RBAC\. Act on an owner's account via X-Driftstack-Account\./);
    // V-1015 — the field once advertised the auth-path integration as future work.
    expect(p, 'the retracted pending-integration anchor is back').not.toMatch(/V-298d/);
  });

  // ─── DriftstackOptions / config shape (TS) ────────────────────

  it('CRITICAL TS DriftstackOptions interface pinned — apiKey (required) + baseUrl (optional) + retry (RetryConfig) + timeoutMs (default 30000) + fetch (override for test seams). Drift to dropping any would break test code or override hooks.', () => {
    const p = read(TS);
    expect(p).toMatch(/export interface DriftstackOptions \{/);
    expect(p).toMatch(
      /\/\*\* Long-lived API key \(`ds_live_…` or `ds_test_…`\)\. \*\/\s*\n\s+apiKey: string;/,
    );
    expect(p).toMatch(/baseUrl\?: string;/);
    expect(p).toMatch(/retry\?: RetryConfig;/);
    expect(p).toMatch(/timeoutMs\?: number;/);
    expect(p).toMatch(/fetch\?: typeof fetch;/);
  });

  // ─── Python api_key validation ────────────────────────────────

  it("CRITICAL Python _validate_api_key raises TypeError on missing/non-string api_key. The 'api_key is required and must be a string' wording is the load-bearing 'no silent defaults' framing — drift to allowing None or auto-fetching from env would let customers ship insecure code.", () => {
    const p = read(PY);
    expect(p).toMatch(/def _validate_api_key\(api_key: str\) -> None:/);
    expect(p).toMatch(/raise TypeError\("Driftstack: api_key is required and must be a string"\)/);
  });

  // ─── Python sync + async dual framing ─────────────────────────

  it("CRITICAL Python client.py header pins the dual-class pattern — 'Two parallel classes — :class:`Driftstack` (sync, httpx.Client) and :class:`AsyncDriftstack` (async, httpx.AsyncClient). Mirrors the pattern used by Stripe-Python, OpenAI-Python, Anthropic-Python'. Drift would lose the 'we follow the Python-ecosystem convention' teaching anchor.", () => {
    const p = read(PY);
    expect(p).toMatch(
      /Two parallel classes — :class:`Driftstack` \(sync, ``httpx\.Client``\)\s*\nand :class:`AsyncDriftstack` \(async, ``httpx\.AsyncClient``\)\./,
    );
    expect(p).toMatch(
      /Mirrors\s*\nthe pattern used by Stripe-Python, OpenAI-Python, Anthropic-Python\./,
    );
  });

  // ─── Go functional-options pattern ────────────────────────────

  it("CRITICAL Go client uses functional-options pattern — 'type Option func(*Client)'. The Option-as-function shape is Go-idiomatic for variadic constructor config; drift to a config-struct constructor would break the WithXxx ergonomic.", () => {
    const p = read(GO);
    expect(p).toMatch(/\/\/ Option is the functional-options shape for \[New\]\./);
    expect(p).toMatch(/^type Option func\(\*Client\)$/m);
  });

  // ─── Go Close() framing ───────────────────────────────────────

  it("CRITICAL Go Client.Close() framing pinned. The 'close with Close (which is a no-op when the underlying http.Client is the default one — only matters if you've passed a custom client whose Transport holds resources)' wording explains why Close exists despite usually being no-op.", () => {
    const p = read(GO);
    expect(p).toMatch(
      /close with Close\s*\n\/\/ \(which is a no-op when the underlying http\.Client is the default\s*\n\/\/ one — only matters if you've passed a custom client whose Transport\s*\n\/\/ holds resources\)\./,
    );
  });

  // ─── Go base-url + retry + http triple ────────────────────────

  it('CRITICAL Go Client struct fields pinned — apiKey + baseURL + http + timeout + retry. Drift to a different internal layout would break the WithXxx options + the package-private impl methods. (sweep-3 added a `timeout time.Duration` field so a body-declared long-running op can auto-raise the per-request context deadline.)', () => {
    const p = read(GO);
    expect(p).toMatch(
      /apiKey +string\s*\n\s+baseURL string\s*\n(\s*\/\/[^\n]*\n)*\s+effectiveAccount string\s*\n\s+http +\*http\.Client\s*\n(\s*\/\/[^\n]*\n)*\s+timeout +time\.Duration\s*\n\s+retry +RetryConfig/,
    );
  });

  it('CRITICAL every required resource is instantiated on both Python clients. V-1093: the Python half of the arm above asserts four import lines and nothing else, so no accessor assignment was checked at all — deleting `self.archetypes` from the sync client left the ENTIRE unit suite green, 1946 files, while the same deletion in TypeScript failed two. Imports cannot stand in for the assignment: sync and async classes are imported on one line, so the import survives either deletion.', () => {
    const py = read(PY);
    const snake = (ts: string): string => ts.replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`);
    const missing: string[] = [];
    for (const [tsName, tsClass] of REQUIRED_RESOURCES) {
      const field = snake(tsName);
      if (!py.includes(`self.${field} = ${tsClass}(self._http)`)) {
        missing.push(`sync: self.${field} = ${tsClass}(self._http)`);
      }
      if (!py.includes(`self.${field} = Async${tsClass}(self._http)`)) {
        missing.push(`async: self.${field} = Async${tsClass}(self._http)`);
      }
    }
    expect(
      missing.sort(),
      'these resource accessors are required of every SDK but are not assigned on the Python ' +
        'client — a customer calling one gets AttributeError, and until now nothing said so:',
    ).toEqual([]);
  });

  it('CRITICAL every resource the Go client exposes appears in the required roster. V-1093: the roster above is the population every other arm loops over, so a resource missing from it is not reported as missing — it is simply not looked at. `archetypes` sat in that blind spot on all three clients, and deleting it from the TypeScript or Python client would have left this file green. Deriving the surface from the Go struct is what makes an omission visible.', () => {
    const go = read(GO);
    const at = go.indexOf('// Resource accessors (filled in by New).');
    expect(at, 'the Go accessor block header moved — nothing was derived').toBeGreaterThan(0);
    const block = go.slice(at, go.indexOf('\n}', at));
    const onStruct = [...block.matchAll(/^\t([A-Z]\w*)\s+\*\w+Resource$/gm)].map((m) => m[1]!);

    expect(onStruct.length, 'resource accessors parsed off the Go client struct').toBeGreaterThan(
      15,
    );

    // Widened deliberately: `as const` makes this a Set of the eighteen literals,
    // and asking such a Set whether it holds a parsed string is a type error rather
    // than the question this arm exists to ask.
    const rostered = new Set<string>(REQUIRED_RESOURCES.map(([, , goName]) => goName));
    expect(
      onStruct.filter((n) => !rostered.has(n)).sort(),
      'these resources exist on the Go client but are in no cross-SDK arm above, so dropping one ' +
        'from the TypeScript or Python client would go unreported — add each to REQUIRED_RESOURCES:',
    ).toEqual([]);
    expect(
      [...rostered].filter((n) => !onStruct.includes(n)).sort(),
      'these are required of all three SDKs but the Go client no longer carries them:',
    ).toEqual([]);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-client-constructor-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
