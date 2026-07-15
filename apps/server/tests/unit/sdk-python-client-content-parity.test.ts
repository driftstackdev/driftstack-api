// W585.A — drift guard for packages/sdk-python/src/driftstack/client.py.
// Top-level Driftstack / AsyncDriftstack factory. Drift here either
// drops a resource accessor (sync + async pair must stay symmetric)
// or breaks the with-statement / context-manager pattern.
//
//   • Two parallel classes: Driftstack (sync httpx.Client) +
//     AsyncDriftstack (async httpx.AsyncClient).
//   • Constructor: api_key positional + base_url + timeout_s + retry
//     + http_client kwarg-only.
//   • DEFAULT_BASE_URL = https://api.driftstack.dev.
//   • _validate_api_key TypeError-raises for falsy/non-string.
//   • 14 resource accessors: sessions / api_keys / usage / webhooks /
//     profiles / profile_snapshots / billing / crypto_orders / auth /
//     account / mfa / audit_log / email_preferences / legal / team.
//   • Sync: close + __enter__ + __exit__; Async: aclose + __aenter__
//     + __aexit__.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/client.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W585.A packages/sdk-python/src/driftstack/client.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + Driftstack/AsyncDriftstack parallel framing + Stripe/OpenAI/Anthropic pattern reference pinned', () => {
    expect(body).toMatch(/^"""Top-level Driftstack client\.\n/);
    expect(body).toMatch(/Two parallel classes — :class:`Driftstack` \(sync, ``httpx\.Client``\)/);
    expect(body).toMatch(
      /and :class:`AsyncDriftstack` \(async, ``httpx\.AsyncClient``\)\. Mirrors/,
    );
    expect(body).toMatch(/the pattern used by Stripe-Python, OpenAI-Python, Anthropic-Python\./);
    expect(body).toMatch(/Every accessor below is backed by its synchronous and asynchronous/);
    expect(body).not.toMatch(/placeholders in this commit|implementations land in PY2/);
    expect(body).toMatch(/Constructor, authentication, transport and/);
    expect(body).toMatch(/resource behavior are covered by the SDK test suite\./);
  });

  it('14 resource imports paired + RetryConfig + DEFAULT_BASE_URL = https://api.driftstack.dev + _validate_api_key TypeError on falsy/non-string pinned', () => {
    expect(body).toMatch(
      /^from driftstack\.resources\.account import AccountResource, AsyncAccountResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.api_keys import ApiKeysResource, AsyncApiKeysResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.audit_log import AsyncAuditLogResource, AuditLogResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.auth import AsyncAuthResource, AuthResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.billing import AsyncBillingResource, BillingResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.crypto_orders import \(\s*\n\s*AsyncCryptoOrdersResource,\s*\n\s*CryptoOrdersResource,\s*\n\)$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.email_preferences import \(\s*\n\s*AsyncEmailPreferencesResource,\s*\n\s*EmailPreferencesResource,\s*\n\)$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.legal import AsyncLegalResource, LegalResource$/m,
    );
    expect(body).toMatch(/^from driftstack\.resources\.mfa import AsyncMfaResource, MfaResource$/m);
    expect(body).toMatch(
      /^from driftstack\.resources\.profile_snapshots import \(\s*\n\s*AsyncProfileSnapshotsResource,\s*\n\s*ProfileSnapshotsResource,\s*\n\)$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.profiles import AsyncProfilesResource, ProfilesResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.sessions import AsyncSessionsResource, SessionsResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.team import AsyncTeamResource, TeamResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.usage import AsyncUsageResource, UsageResource$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.resources\.webhooks import AsyncWebhooksResource, WebhooksResource$/m,
    );
    expect(body).toMatch(/^from driftstack\.retry import RetryConfig$/m);
    expect(body).toMatch(/^DEFAULT_BASE_URL = "https:\/\/api\.driftstack\.dev"$/m);
    expect(body).toMatch(
      /def _validate_api_key\(api_key: str\) -> None:\s*\n\s*if not api_key or not isinstance\(api_key, str\):\s*\n\s*raise TypeError\("Driftstack: api_key is required and must be a string"\)/,
    );
  });

  it('Sync Driftstack: constructor pinned (api_key + kwarg-only base_url/timeout_s/retry/http_client) + 14 resource accessors with V-NNN comments + close + __enter__ + __exit__ context manager', () => {
    expect(body).toMatch(/^class Driftstack:$/m);
    expect(body).toMatch(/"""Synchronous Driftstack API client\./);
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(/client = Driftstack\(api_key="ds_live_…"\)/);
    expect(body).toMatch(/session = client\.sessions\.create\(\)/);
    expect(body).toMatch(
      /def __init__\(\s*\n\s*self,\s*\n\s*api_key: str,\s*\n\s*\*,\s*\n\s*base_url: str = DEFAULT_BASE_URL,\s*\n\s*timeout_s: float = 30\.0,\s*\n\s*retry: RetryConfig \| None = None,\s*\n\s*http_client: httpx\.Client \| None = None,\s*\n\s*effective_account: str \| None = None,\s*\n\s*\) -> None:/,
    );
    expect(body).toMatch(/_validate_api_key\(api_key\)/);
    expect(body).toMatch(
      /self\._http = HttpClient\(\s*\n\s*api_key,\s*\n\s*base_url=base_url,\s*\n\s*timeout_s=timeout_s,\s*\n\s*retry=retry,\s*\n\s*effective_account=effective_account,\s*\n\s*client=http_client,\s*\n\s*\)/,
    );
    expect(body).toMatch(/self\.sessions = SessionsResource\(self\._http\)/);
    expect(body).toMatch(/self\.api_keys = ApiKeysResource\(self\._http\)/);
    expect(body).toMatch(/self\.usage = UsageResource\(self\._http\)/);
    expect(body).toMatch(/self\.webhooks = WebhooksResource\(self\._http\)/);
    expect(body).toMatch(/self\.profiles = ProfilesResource\(self\._http\)/);
    expect(body).toMatch(/# V-312 — immutable point-in-time profile snapshots\./);
    expect(body).toMatch(/self\.profile_snapshots = ProfileSnapshotsResource\(self\._http\)/);
    expect(body).toMatch(/self\.billing = BillingResource\(self\._http\)/);
    expect(body).toMatch(/# V-666 — crypto-checkout \/ crypto-orders\./);
    expect(body).toMatch(/self\.crypto_orders = CryptoOrdersResource\(self\._http\)/);
    expect(body).toMatch(/self\.auth = AuthResource\(self\._http\)/);
    expect(body).toMatch(/# V-385 \/ V-434 — \/v1\/account\/me rich-shape read\./);
    expect(body).toMatch(/self\.account = AccountResource\(self\._http\)/);
    expect(body).toMatch(/# V-353b \/ V-448 — MFA enrollment management\./);
    expect(body).toMatch(/self\.mfa = MfaResource\(self\._http\)/);
    expect(body).toMatch(/# V-216 \/ V-449 — audit-log read \+ iterate\./);
    expect(body).toMatch(/self\.audit_log = AuditLogResource\(self\._http\)/);
    expect(body).toMatch(/# V-204 \/ V-449 — email preferences\./);
    expect(body).toMatch(/self\.email_preferences = EmailPreferencesResource\(self\._http\)/);
    expect(body).toMatch(/# V-049 \/ V-458 — legal acceptance\./);
    expect(body).toMatch(/self\.legal = LegalResource\(self\._http\)/);
    expect(body).toMatch(/# V-298c — Team RBAC\. Auth path integration is V-298d\./);
    expect(body).toMatch(/self\.team = TeamResource\(self\._http\)/);
    expect(body).toMatch(/def close\(self\) -> None:\s*\n\s*self\._http\.close\(\)/);
    expect(body).toMatch(/def __enter__\(self\) -> Driftstack:\s*\n\s*return self/);
    expect(body).toMatch(/def __exit__\(self, \*_excinfo: Any\) -> None:\s*\n\s*self\.close\(\)/);
  });

  it('Async AsyncDriftstack: mirrored 14-resource accessor wiring + AsyncHttpClient via httpx.AsyncClient + aclose + __aenter__ + __aexit__ async-context-manager', () => {
    expect(body).toMatch(/^class AsyncDriftstack:$/m);
    expect(body).toMatch(/"""Async Driftstack API client\. asyncio-compatible\."""/);
    expect(body).toMatch(/http_client: httpx\.AsyncClient \| None = None,/);
    expect(body).toMatch(/self\._http = AsyncHttpClient\(/);
    expect(body).toMatch(/self\.sessions = AsyncSessionsResource\(self\._http\)/);
    expect(body).toMatch(/self\.crypto_orders = AsyncCryptoOrdersResource\(self\._http\)/);
    expect(body).toMatch(/self\.team = AsyncTeamResource\(self\._http\)/);
    expect(body).toMatch(/async def aclose\(self\) -> None:\s*\n\s*await self\._http\.aclose\(\)/);
    expect(body).toMatch(/async def __aenter__\(self\) -> AsyncDriftstack:\s*\n\s*return self/);
    expect(body).toMatch(
      /async def __aexit__\(self, \*_excinfo: Any\) -> None:\s*\n\s*await self\.aclose\(\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
