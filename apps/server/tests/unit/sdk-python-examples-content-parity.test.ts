// W620 — drift guard for packages/sdk-python/examples/*.py (9 files).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const E = (rel: string) => resolve(REPO_ROOT, `packages/sdk-python/examples/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W620 sdk-python/examples content parity', () => {
  it('quickstart.py: DRIFTSTACK_API_KEY + DRIFTSTACK_BASE_URL fallback to https://api.driftstack.dev + with-Driftstack-ctx + create session label=quickstart + navigate example.com + screenshot capture + idempotent destroy pinned', () => {
    const body = read(E('quickstart.py'));
    expect(body).toMatch(/^"""Quickstart: create a session, navigate, capture, destroy\.$/m);
    expect(body).toMatch(/from __future__ import annotations/);
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(/api_key = os\.environ\.get\("DRIFTSTACK_API_KEY"\)/);
    expect(body).toMatch(
      /base_url = os\.environ\.get\("DRIFTSTACK_BASE_URL", "https:\/\/api\.driftstack\.dev"\)/,
    );
    expect(body).toMatch(/with Driftstack\(api_key=api_key, base_url=base_url\) as client:/);
    expect(body).toMatch(/session = client\.sessions\.create\(\{"label": "quickstart"\}\)/);
    expect(body).toMatch(
      /client\.sessions\.navigate\(str\(session\.id\), \{"url": "https:\/\/example\.com\/"\}\)/,
    );
    expect(body).toMatch(
      /capture = client\.sessions\.capture\(str\(session\.id\), \{"kind": "screenshot"\}\)/,
    );
    expect(body).toMatch(/Destroying a session is idempotent — safe to call twice\./);
    expect(body).toMatch(/client\.sessions\.destroy\(str\(session\.id\)\)/);
    expect(existsSync(E('quickstart.py'))).toBe(true);
  });

  it('billing_flow.py: /billing-page mirror + get_state branching (no-sub → create_checkout_session api_builder monthly with success/cancel urls / has-sub → create_portal_session) pinned (trial_pack block removed 2026-05-27)', () => {
    const body = read(E('billing_flow.py'));
    expect(body).toMatch(/^"""Customer billing self-serve flow — mirror the customer-dashboard$/m);
    expect(body).toMatch(/\/billing page in code form/);
    expect(body).toMatch(/state = client\.billing\.get_state\(\)/);
    expect(body).toMatch(/if state\.get\("subscription"\) is None:/);
    expect(body).toMatch(/co = client\.billing\.create_checkout_session\(/);
    expect(body).toMatch(/"tier": "api_builder",/);
    expect(body).toMatch(/"billing_period": "monthly",/);
    expect(body).toMatch(/"success_url": "https:\/\/app\.driftstack\.dev\/billing\?ok=1",/);
    expect(body).toMatch(/"cancel_url": "https:\/\/app\.driftstack\.dev\/billing\?cancelled=1",/);
    expect(body).toMatch(/portal = client\.billing\.create_portal_session\(\)/);
    expect(existsSync(E('billing_flow.py'))).toBe(true);
  });

  it('error_handling.py: typed-exception subclasses import (AuthError + ConcurrencyLimitError + Driftstack + DriftstackError + QuotaExceededError + RateLimitError + ValidationError) + granular except blocks + 5-attempt manual retry loop + retry_after_seconds fallback to 2**attempt pinned', () => {
    const body = read(E('error_handling.py'));
    expect(body).toMatch(
      /^"""Error handling: catching the right Driftstack exceptions and retrying\.$/m,
    );
    expect(body).toMatch(/from driftstack import \(/);
    expect(body).toMatch(/^\s+AuthError,$/m);
    expect(body).toMatch(/^\s+ConcurrencyLimitError,$/m);
    expect(body).toMatch(/^\s+Driftstack,$/m);
    expect(body).toMatch(/^\s+DriftstackError,$/m);
    expect(body).toMatch(/^\s+QuotaExceededError,$/m);
    expect(body).toMatch(/^\s+RateLimitError,$/m);
    expect(body).toMatch(/^\s+ValidationError,$/m);
    expect(body).toMatch(/except AuthError:/);
    expect(body).toMatch(/except ConcurrencyLimitError as e:/);
    expect(body).toMatch(
      /hit the concurrent-session ceiling \(\{e\.current_sessions\}\/\{e\.limit\}\)/,
    );
    expect(body).toMatch(/except QuotaExceededError as e:/);
    expect(body).toMatch(
      /monthly quota for \{e\.record_type\} exhausted \(\{e\.current\}\/\{e\.limit\}\)/,
    );
    expect(body).toMatch(/except ValidationError as e:/);
    expect(body).toMatch(/except DriftstackError as e:/);
    expect(body).toMatch(/for attempt in range\(5\):/);
    expect(body).toMatch(/except RateLimitError as e:/);
    expect(body).toMatch(/wait = e\.retry_after_seconds or \(2\*\*attempt\)/);
    expect(body).toMatch(/time\.sleep\(wait\)/);
    expect(existsSync(E('error_handling.py'))).toBe(true);
  });

  it('pagination.py: V-126 iterate() + iterate_deliveries() sync + async + 3 sync funcs (list_all_sessions + list_profiles dict-style + dlq_deliveries_for_first_webhook DLQ filter) + 1 async main + asyncio.run pinned', () => {
    const body = read(E('pagination.py'));
    expect(body).toMatch(/^"""Pagination: walk every session, profile, and DLQ delivery using$/m);
    expect(body).toMatch(/V-126 added ``iterate\(\)`` \/ ``iterate_deliveries\(\)`` helpers/);
    expect(body).toMatch(/Sessions \/ Profiles \/ Webhooks resources for both the sync/);
    expect(body).toMatch(/``Driftstack`` client and the async ``AsyncDriftstack`` client\./);
    expect(body).toMatch(/from driftstack import AsyncDriftstack, Driftstack/);
    expect(body).toMatch(/^def list_all_sessions\(client: Driftstack\) -> None:$/m);
    expect(body).toMatch(/for session in client\.sessions\.iterate\(limit=50\):/);
    expect(body).toMatch(/^def list_profiles\(client: Driftstack\) -> None:$/m);
    expect(body).toMatch(/for profile in client\.profiles\.iterate\(\):/);
    expect(body).toMatch(/^def dlq_deliveries_for_first_webhook\(client: Driftstack\) -> None:$/m);
    expect(body).toMatch(
      /for delivery in client\.webhooks\.iterate_deliveries\(str\(first\.id\), limit=100, status="dlq"\):/,
    );
    expect(body).toMatch(
      /^async def list_all_sessions_async\(aclient: AsyncDriftstack\) -> None:$/m,
    );
    expect(body).toMatch(/async for session in aclient\.sessions\.iterate\(limit=50\):/);
    expect(body).toMatch(
      /async with AsyncDriftstack\(api_key=api_key, base_url=base_url\) as aclient:/,
    );
    expect(body).toMatch(/asyncio\.run\(main_async\(api_key, base_url\)\)/);
    expect(existsSync(E('pagination.py'))).toBe(true);
  });

  it('profile_management.py: profiles end-to-end + V-136 LOCKED_ARCHETYPE_ID + tier counts (Personal=10/Team=50/Agency=200 + ADR-004 API ladder) + 8-step flow (create → iterate → get → update D-032 → V-313 clone → V-312 snapshot → restore → cleanup) pinned', () => {
    const body = read(E('profile_management.py'));
    expect(body).toMatch(/^"""Profile management — profiles surface end-to-end\.$/m);
    expect(body).toMatch(/Personal = 10, Team = 50, Agency/);
    expect(body).toMatch(/Manual = 200/);
    expect(body).toMatch(/the API ladder also caps profiles per ADR-004\./);
    expect(body).toMatch(/V-136 LOCKED_ARCHETYPE_ID/);
    expect(body).toMatch(/created = client\.profiles\.create\(/);
    expect(body).toMatch(/for profile in client\.profiles\.iterate\(limit=50\):/);
    expect(body).toMatch(/fetched = client\.profiles\.get\(created\["id"\]\)/);
    expect(body).toMatch(/scoped to \(account_id, name\) per D-032/);
    expect(body).toMatch(/updated = client\.profiles\.update\(/);
    expect(body).toMatch(/# 5\. V-313 — clone the profile/);
    expect(body).toMatch(/cloned = client\.profiles\.clone\(updated\["id"\]\)/);
    expect(body).toMatch(/# 6\. V-312 — capture an immutable point-in-time snapshot\./);
    expect(body).toMatch(/snap = client\.profile_snapshots\.capture\(/);
    expect(body).toMatch(/restored = client\.profile_snapshots\.restore\(/);
    expect(body).toMatch(/client\.profile_snapshots\.delete\(snap\["id"\]\)/);
    expect(existsSync(E('profile_management.py'))).toBe(true);
  });

  it('webhook_receiver.py: stdlib-only receiver + signature verification + emitted core-event HANDLERS map + 204 ack within 30s pinned', () => {
    const body = read(E('webhook_receiver.py'));
    expect(body).toMatch(/^"""Webhook receiver: verify the signature, dispatch by event type\.$/m);
    expect(body).toMatch(/Stdlib-only — no Flask \/ FastAPI \/ Django dependency\./);
    expect(body).toMatch(/from http\.server import BaseHTTPRequestHandler, HTTPServer/);
    expect(body).toMatch(/from driftstack import verify_webhook_signature/);
    expect(body).toMatch(/SECRET = os\.environ\.get\("DRIFTSTACK_WEBHOOK_SECRET", ""\)/);
    expect(body).toMatch(/^def handle_session_completed\(data: dict\[str, Any\]\) -> None:$/m);
    expect(body).toMatch(/^def handle_session_failed\(data: dict\[str, Any\]\) -> None:$/m);
    expect(body).toMatch(/^def handle_api_key_revoked\(data: dict\[str, Any\]\) -> None:$/m);
    expect(body).toMatch(/^HANDLERS = \{$/m);
    expect(body).toMatch(/"session\.completed": handle_session_completed,/);
    expect(body).toMatch(/"session\.failed": handle_session_failed,/);
    expect(body).toMatch(/"api_key\.revoked": handle_api_key_revoked,/);
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
    expect(body).toMatch(/def do_POST\(self\) -> None:/);
    expect(body).toMatch(/signature = self\.headers\.get\("x-driftstack-signature"\)/);
    expect(body).toMatch(
      /if not verify_webhook_signature\(body=body, header=signature, secret=SECRET\):/,
    );
    expect(body).toMatch(/# 2xx confirms receipt\. Driftstack expects this within 30s\./);
    expect(body).toMatch(/self\.send_response\(204\)/);
    expect(body).toMatch(/server = HTTPServer\(\("0\.0\.0\.0", 4242\), _Receiver\)/);
    expect(existsSync(E('webhook_receiver.py'))).toBe(true);
  });

  it('langchain_tool.py: LangChain Tool wrapper sketch + build_driftstack_tools(client) returning list[Any] + 3 tools (driftstack_create_session + driftstack_navigate JSON-str-in + driftstack_destroy_session) + ImportError raise w/ pip install langchain-core hint pinned', () => {
    const body = read(E('langchain_tool.py'));
    expect(body).toMatch(
      /^"""LangChain tool wrapper: expose Driftstack as a tool an agent can call\.$/m,
    );
    expect(body).toMatch(/Install LangChain separately::/);
    expect(body).toMatch(/^\s+pip install langchain-core$/m);
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(/^def build_driftstack_tools\(client: Driftstack\) -> list\[Any\]:$/m);
    expect(body).toMatch(/from langchain_core\.tools import Tool/);
    expect(body).toMatch(/Install langchain-core to use this helper: pip install langchain-core/);
    expect(body).toMatch(/def create_session\(_input: str = ""\) -> str:/);
    expect(body).toMatch(/s = client\.sessions\.create\(\)/);
    expect(body).toMatch(/def navigate\(payload: str\) -> str:/);
    expect(body).toMatch(
      /result = client\.sessions\.navigate\(args\["session_id"\], \{"url": args\["url"\]\}\)/,
    );
    expect(body).toMatch(/def destroy_session\(session_id: str\) -> str:/);
    expect(body).toMatch(/name="driftstack_create_session",/);
    expect(body).toMatch(/name="driftstack_navigate",/);
    expect(body).toMatch(/name="driftstack_destroy_session",/);
    expect(existsSync(E('langchain_tool.py'))).toBe(true);
  });

  it('pytest_fixture.py: pytest + respx + httpx imports + _BASE=api.driftstack.test + mock_driftstack fixture yields (Driftstack client + respx.MockRouter) + ds_test_fakefakefakefakefakefakefakefake key + SESSION_FIXTURE shape (ses_/acc_/key_ prefixed UUIDs) pinned', () => {
    const body = read(E('pytest_fixture.py'));
    expect(body).toMatch(
      /^"""pytest fixture pattern — mock the Driftstack SDK in customer tests\.$/m,
    );
    expect(body).toMatch(/Drop the contents of ``mock_driftstack`` into your project's/);
    expect(body).toMatch(/^\s+pip install pytest respx$/m);
    expect(body).toMatch(/import httpx/);
    expect(body).toMatch(/import pytest/);
    expect(body).toMatch(/import respx/);
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(/_BASE = "https:\/\/api\.driftstack\.test"/);
    expect(body).toMatch(/^@pytest\.fixture$/m);
    expect(body).toMatch(
      /^def mock_driftstack\(\) -> Generator\[tuple\[Driftstack, respx\.MockRouter\], None, None\]:$/m,
    );
    expect(body).toMatch(/with respx\.mock\(base_url=_BASE\) as mock:/);
    expect(body).toMatch(/api_key="ds_test_fakefakefakefakefakefakefakefake", base_url=_BASE/);
    expect(body).toMatch(/^SESSION_FIXTURE = \{$/m);
    expect(body).toMatch(/"id": "ses_00000000-0000-4000-8000-000000000001",/);
    expect(body).toMatch(/"account_id": "acc_00000000-0000-4000-8000-000000000001",/);
    expect(body).toMatch(/"api_key_id": "key_00000000-0000-4000-8000-000000000001",/);
    expect(body).toMatch(/"status": "ready",/);
    expect(body).toMatch(/"archetype": "iphone17_ios18_7_safari26_4",/);
    expect(existsSync(E('pytest_fixture.py'))).toBe(true);
  });

  it('crypto_checkout.py: V-666 Python + uuid.uuid4 idempotency_key kwarg V-666.AO + 6-step flow (quote solo_manual → create_checkout idempotency_key= → demo-poll 3× w/ explicit "use webhooks in production" caveat → update_note PO-0001 → receipt → iterate paid 7-day window) + non-refundable framing pinned', () => {
    const body = read(E('crypto_checkout.py'));
    expect(body).toMatch(/^"""Crypto-checkout self-serve flow — V-666 Python example\.$/m);
    expect(body).toMatch(/``client\.crypto_orders`` resource: quote, mint a checkout with an/);
    expect(body).toMatch(/Crypto payments are non-refundable\./);
    expect(body).toMatch(/^import uuid$/m);
    expect(body).toMatch(/quote = client\.crypto_orders\.quote\(\{"product": "solo_manual"\}\)/);
    expect(body).toMatch(/idempotency_key = str\(uuid\.uuid4\(\)\)/);
    expect(body).toMatch(/order = client\.crypto_orders\.create_checkout\(/);
    expect(body).toMatch(/idempotency_key=idempotency_key,/);
    expect(body).toMatch(/# 3\) For demo purposes, poll status\. PRODUCTION CALLERS: subscribe/);
    expect(body).toMatch(/# {4}to the `crypto\.order\.paid` webhook instead/);
    expect(body).toMatch(/Polling status \(demo only — use webhooks in production\)\.\.\./);
    expect(body).toMatch(/latest = client\.crypto_orders\.get\(order_id\)/);
    expect(body).toMatch(
      /client\.crypto_orders\.update_note\(order_id, \{"customer_note": "demo PO-0001"\}\)/,
    );
    expect(body).toMatch(/receipt = client\.crypto_orders\.receipt\(order_id\)/);
    expect(body).toMatch(/from datetime import datetime, timedelta, timezone/);
    expect(body).toMatch(
      /since = \(datetime\.now\(timezone\.utc\) - timedelta\(days=7\)\)\.isoformat\(\)/,
    );
    expect(body).toMatch(
      /for hist in client\.crypto_orders\.iterate\(status="paid", created_after=since, limit=50\):/,
    );
    expect(existsSync(E('crypto_checkout.py'))).toBe(true);
  });

  it("agent_chat.py: python invocation + DRIFTSTACK_API_KEY env-gate + DRIFTSTACK_BYOK_ANTHROPIC_API_KEY optional env demo + agent_sessions.create + message multi-turn (plan-executed/clarify/refuse) + FeatureUnavailableError activation-gate exit-code-2 + `os.environ.get(...) or None` empty-string falsy-coalesce — pinned so slice 139's BYOK demo survives + so a future refactor that drops the `or None` collapse (which Python SDK's `if byok_api_key` guard relies on for the cross-SDK empty-string-skip contract from slices 126-128) trips the test", () => {
    const body = read(E('agent_chat.py'));
    expect(body).toMatch(/DRIFTSTACK_API_KEY=ds_live_… python examples\/agent_chat\.py/);
    expect(body).toMatch(/DRIFTSTACK_BYOK_ANTHROPIC_API_KEY=sk-ant-…/);
    expect(body).toMatch(
      /byok_key = os\.environ\.get\("DRIFTSTACK_BYOK_ANTHROPIC_API_KEY"\) or None/,
    );
    expect(body).toMatch(
      /resp = client\.agent_sessions\.message\(session\["id"\], prompt, byok_api_key=byok_key\)/,
    );
    expect(body).toMatch(/kind == "plan-executed"/);
    expect(body).toMatch(/kind == "clarify"/);
    expect(body).toMatch(/kind == "refuse"/);
    expect(body).toMatch(/except FeatureUnavailableError as e:/);
    expect(body).toMatch(/return 2/);
    expect(body).toMatch(/client\.agent_sessions\.close\(session\["id"\]\)/);
    expect(existsSync(E('agent_chat.py'))).toBe(true);
  });
});
