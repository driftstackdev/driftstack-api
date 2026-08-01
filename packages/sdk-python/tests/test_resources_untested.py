"""MFA, legal and email-preference resources — driven, sync and async.

These three had no behavioural coverage in this suite. Measured, not assumed:
the only occurrence of "mfa" anywhere under ``tests/`` was ``"mfa_enrolled":
False`` inside an account fixture, and ``legal`` and ``email_preferences``
were referenced only through their sibling resources.

They were not unguarded. Content-parity pins in the server suite hold each
method's verb, path and docstring for BOTH the sync and async classes, and they
are exhaustive — three separate divergences introduced against them all red,
including swapping two async paths so the file's path set stayed identical.

What no source-text pin can show is that calling the method puts that request on
the wire. These go through ``respx``, so what is asserted is the HTTP the SDK
actually emits, including the JSON body.

Async is covered alongside sync deliberately. The SDK writes each resource out
twice rather than generating the mirror, so the async class is the half more
likely to drift, and it is also the half no test here has ever executed.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


# ─────────────────────────────── MFA ────────────────────────────────


def test_mfa_status_and_enroll_hit_distinct_paths() -> None:
    """status reads, enroll mints. One path segment apart, and confusing them
    would hand a customer a fresh secret every time they opened the page."""
    with respx.mock(base_url=BASE) as mock:
        status = mock.get("/v1/account/mfa").mock(
            return_value=httpx.Response(200, json={"enrolled": False})
        )
        enroll = mock.post("/v1/account/mfa/enroll").mock(
            return_value=httpx.Response(200, json={"otpauth_uri": "otpauth://x", "secret": "s"})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.mfa.status()
            client.mfa.enroll()
        assert status.called
        assert enroll.called


def test_mfa_verify_sends_the_callers_code_verbatim() -> None:
    """Rewriting or dropping this body makes every enrollment fail with a
    correct code, and the failure looks like the customer mistyping."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/account/mfa/verify").mock(
            return_value=httpx.Response(200, json={"recovery_codes": ["a", "b"]})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.mfa.verify({"code": "123456"})
        assert route.calls[0].request.content == b'{"code":"123456"}'
        assert result["recovery_codes"] == ["a", "b"]


def test_mfa_disable_uses_delete_and_carries_the_confirmation_phrase() -> None:
    """The body is a literal confirmation phrase, not a TOTP code — a
    deliberate speed bump in front of removing the customer's second factor."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/account/mfa").mock(return_value=httpx.Response(204))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.mfa.disable({"confirm": "disable-mfa"})
        assert route.calls[0].request.method == "DELETE"
        assert route.calls[0].request.content == b'{"confirm":"disable-mfa"}'


def test_mfa_regenerate_recovery_codes_posts_to_its_own_path() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/account/mfa/recovery-codes/regenerate").mock(
            return_value=httpx.Response(200, json={"recovery_codes": []})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.mfa.regenerate_recovery_codes()
        assert route.called


@pytest.mark.asyncio
async def test_async_mfa_mirrors_the_sync_wire_contract() -> None:
    """The async class is written out separately, so it is the half that drifts
    — and until now the half nothing here executed."""
    with respx.mock(base_url=BASE) as mock:
        verify = mock.post("/v1/account/mfa/verify").mock(
            return_value=httpx.Response(200, json={"recovery_codes": ["z"]})
        )
        disable = mock.delete("/v1/account/mfa").mock(return_value=httpx.Response(204))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.mfa.verify({"code": "654321"})
            await client.mfa.disable({"confirm": "disable-mfa"})
        assert verify.calls[0].request.content == b'{"code":"654321"}'
        assert disable.calls[0].request.method == "DELETE"
        assert result["recovery_codes"] == ["z"]


# ────────────────────────────── legal ───────────────────────────────


def test_legal_documents_and_required_are_distinct_reads() -> None:
    """The catalogue versus what this account still owes. A copy-paste between
    them would tell a customer they have nothing left to accept."""
    with respx.mock(base_url=BASE) as mock:
        docs = mock.get("/v1/legal/documents").mock(
            return_value=httpx.Response(200, json={"data": []})
        )
        req = mock.get("/v1/legal/required").mock(
            return_value=httpx.Response(200, json={"data": []})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.legal.documents()
            client.legal.required()
        assert docs.called
        assert req.called


def test_legal_accept_posts_the_acceptance_tuple_verbatim() -> None:
    """content_hash binds the acceptance to an exact document version; a body
    that drops it records consent to nothing in particular."""
    body = {"document_key": "tos", "version": "2026-01", "content_hash": "abc123"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/legal/accept").mock(
            return_value=httpx.Response(200, json={"accepted_at": "2026-08-01T00:00:00Z"})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.legal.accept(body)
        sent = route.calls[0].request.content
        for key, value in body.items():
            assert key.encode() in sent
            assert value.encode() in sent


@pytest.mark.asyncio
async def test_async_legal_required_hits_the_required_path() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/legal/required").mock(
            return_value=httpx.Response(200, json={"data": []})
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.legal.required()
        assert route.called


# ───────────────────────── email preferences ────────────────────────


def test_email_preferences_set_uses_put() -> None:
    """PUT rather than POST: the server treats this as an idempotent upsert of
    one event type, so a POST would be a different contract."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.put("/v1/account/email-preferences").mock(return_value=httpx.Response(204))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.email_preferences.set({"event_type": "billing-receipt", "opted_in": True})
        assert route.calls[0].request.method == "PUT"


def test_opt_out_and_opt_in_send_opposite_polarity() -> None:
    """These delegate to the same set() one boolean apart. Swapping them opts a
    customer back IN to mail they asked to stop — a consent defect, and one that
    a reader skimming two near-identical one-line methods will not see."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.put("/v1/account/email-preferences").mock(return_value=httpx.Response(204))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.email_preferences.opt_out("billing-receipt")
            client.email_preferences.opt_in("billing-receipt")
        out_body, in_body = route.calls[0].request.content, route.calls[1].request.content
        assert b'"opted_in":false' in out_body
        assert b'"opted_in":true' in in_body
        # Asserted against each other too: identical polarity in both would fail
        # only by accident of which literal happened to be wrong.
        assert out_body != in_body


def test_opt_out_forwards_the_event_type_it_was_given() -> None:
    """So opting out of one email does not silence a different one."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.put("/v1/account/email-preferences").mock(return_value=httpx.Response(204))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.email_preferences.opt_out("tier-changed")
        assert b'"event_type":"tier-changed"' in route.calls[0].request.content


@pytest.mark.asyncio
async def test_async_opt_out_sends_false_too() -> None:
    """The async mirror carries the same consent semantics; it is a separate
    one-line method and therefore a separate chance to invert the boolean."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.put("/v1/account/email-preferences").mock(return_value=httpx.Response(204))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.email_preferences.opt_out("billing-receipt")
        assert b'"opted_in":false' in route.calls[0].request.content


# ───────────────────── account web-session revocation ────────────────


def test_revoke_all_other_web_sessions_sends_keep_current() -> None:
    """The endpoint REFUSES a bulk revoke without ?keep=current -- "Bulk revoke
    requires `?keep=current`. Pass it explicitly to confirm intent." Omitting it
    made this method a guaranteed 400 in all three SDKs, while the dashboard,
    which always sent it, worked. Every guard pinned the method signature; none
    asserted the URL."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/account/web-sessions").mock(return_value=httpx.Response(204))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.account.revoke_all_other_web_sessions()
        assert route.calls[0].request.url.params["keep"] == "current"


@pytest.mark.asyncio
async def test_async_revoke_all_other_web_sessions_sends_keep_current() -> None:
    """The async mirror is a separate method and therefore a separate chance to
    omit the query."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/account/web-sessions").mock(return_value=httpx.Response(204))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.account.revoke_all_other_web_sessions()
        assert route.calls[0].request.url.params["keep"] == "current"
