import asyncio
import json
import os
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from time import monotonic
from uuid import UUID, uuid4

import httpx
import jwt
import pytest
import sqlalchemy as sa
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy.exc import DBAPIError
from test_routing_and_contracts import MESSAGE

from aegis import models as db
from aegis.accounting import Accounting
from aegis.admin import ACTOR, demo_enrollment, enroll
from aegis.api import create_app
from aegis.catalog import utc_month, write_policy
from aegis.contracts import ActivePolicyChange, Chat, Principal, ProviderEvent, RequestInfo, TokenUsage
from aegis.database import Database, lock_catalog, lock_tenant
from aegis.errors import GatewayError
from aegis.providers.mock import Mock
from aegis.reliability import Controls
from aegis.routing import latency_class_for, routing_decision

pytestmark = pytest.mark.integration
CHAT = "/v1/chat/completions"


def body(model="mock-chat", **options):
    return {"model": model, "messages": MESSAGE, **options}


def range_today():
    today = datetime.now(UTC).date()
    return {"from": str(today), "to": str(today + timedelta(days=1))}


async def records(rt, tenant, request_id):
    async with rt.admin.transaction() as conn:
        rows = (
            (
                await conn.execute(
                    sa.select(db.attempts)
                    .where(
                        db.attempts.c.tenant_id == tenant,
                        db.attempts.c.request_id == request_id,
                    )
                    .order_by(db.attempts.c.ordinal)
                )
            )
            .mappings()
            .all()
        )
        account = (
            (await conn.execute(sa.select(db.budget_periods).where(db.budget_periods.c.tenant_id == tenant)))
            .mappings()
            .one()
        )
    return rows, account


async def fixture_route(rt, tenant, fixture, *, ambiguous=False, cap=None):
    alias = "fixture-" + uuid4().hex
    async with rt.admin.transaction() as conn:
        await lock_catalog(conn, exclusive=True)
        await lock_tenant(conn, tenant, exclusive=True)
        deployments = []
        for index, model in enumerate([fixture, "mock-v1"]):
            spec = demo_enrollment().model_copy(
                update={
                    "name": f"{alias}-{index}",
                    "aliases": [alias],
                    "upstream_model": model,
                    "quota_group": f"{alias}-{index}",
                }
            )
            deployment, revision = await enroll(conn, tenant, spec, "Integration fixture")
            deployments.append(deployment)
        primary, fallback = deployments
        change = ActivePolicyChange(
            model=alias,
            expected_revision=0,
            catalog_revision=revision,
            change_reason="Integration fixture",
            data_regions=["local"],
            targets=[
                {"deployment_id": primary, "priority": 100, "weight": 100},
                {"deployment_id": fallback, "priority": 0, "weight": 0},
            ],
            fallback_edges=[{"source": primary, "target": fallback}],
            allow_ambiguous_failover=ambiguous,
            max_request_cost_microusd=cap,
        )
        await write_policy(conn, tenant, change, None, None, ACTOR)
    return alias


async def test_offline_json_stream_usage_and_health(runtime):
    rt = runtime
    tenant = await rt.seed()
    headers = rt.headers(tenant)
    assert (await rt.http.get("/v1/health")).json()["status"] == "ok"
    assert (await rt.http.get("/livez")).status_code == 200
    listing = await rt.http.get("/v1/models", headers=headers)
    assert [row["id"] for row in listing.json()["data"]] == ["auto", "mock-chat"]
    response = await rt.http.post(CHAT, json=body(max_tokens=5), headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["id"] == "chatcmpl-" + response.headers["x-request-id"]
    assistant = response.json()["choices"][0]["message"]["content"]
    json_usage = response.json()["usage"]
    assert assistant.startswith("Aegis mock result") and json_usage["total_tokens"] == 15
    streamed = await rt.http.post(
        CHAT,
        json=body("auto", max_tokens=5, stream=True, stream_options={"include_usage": True}),
        headers=headers,
    )
    assert streamed.status_code == 200 and streamed.headers["content-type"].startswith("text/event-stream")
    chunks = [line.removeprefix("data: ") for line in streamed.text.splitlines() if line.startswith("data: ")]
    assert chunks[-1] == "[DONE]" and chunks.count("[DONE]") == 1
    json_chunks = list(map(json.loads, chunks[:-1]))
    assert json_chunks[0]["choices"][0]["delta"] == {"role": "assistant"}
    assert json_chunks[-2]["choices"][0]["finish_reason"] == "stop"
    assert json_chunks[-1]["choices"] == [] and json_chunks[-1]["usage"] == json_usage
    assert "".join(chunk["choices"][0]["delta"].get("content", "") for chunk in json_chunks[:-1]) == assistant
    report = await rt.http.get(
        "/v1/usage", params={**range_today(), "group_by": "model", "limit": 1}, headers=headers
    )
    assert report.status_code == 200, report.text
    page = report.json()
    assert page["data"][0]["model"] == "auto" and page["data"][0]["reported_microusd"] == "20"
    assert page["has_more"] and page["next_cursor"]
    second = await rt.http.get(
        "/v1/usage",
        params={
            **range_today(),
            "group_by": "model",
            "limit": 1,
            "cursor": page["next_cursor"],
        },
        headers=headers,
    )
    assert second.json()["data"][0]["model"] == "mock-chat"
    other = await rt.seed()
    denied = await rt.http.get(
        "/v1/usage",
        params={
            **range_today(),
            "group_by": "model",
            "limit": 1,
            "cursor": page["next_cursor"],
        },
        headers=rt.headers(other),
    )
    assert denied.status_code == 400 and denied.json()["error"]["code"] == "invalid_cursor"
    assert (await rt.http.get("/v1/metrics", headers=headers)).status_code == 401
    metrics = await rt.http.get(
        "/v1/metrics",
        headers={
            "Authorization": "Bearer " + rt.settings.metrics_token.get_secret_value(),
        },
    )
    assert "aegis_provider_attempts_total" in metrics.text and tenant["api_key"] not in metrics.text


async def test_revocation_rls_and_credential_scopes(runtime):
    rt = runtime
    async with rt.app.state.db.transaction() as conn:
        assert await conn.scalar(
            sa.text("SELECT has_function_privilege('aegis.lookup_api_key(text)', 'EXECUTE')")
        )
        assert not await conn.scalar(
            sa.text("SELECT has_function_privilege('aegis.recovery_candidates(integer)', 'EXECUTE')")
        )
    one, two = await rt.seed(), await rt.seed()
    tenant = UUID(one["tenant_id"])
    response = await rt.http.post(CHAT, json=body(max_tokens=2), headers=rt.headers(one))
    key = UUID(one["key_id"])
    assert response.status_code == 200
    other = await rt.http.get("/v1/usage", params=range_today(), headers=rt.headers(two))
    assert other.json()["data"] == []
    switched = await rt.http.get("/v1/models", headers={**rt.headers(one), "X-Tenant-ID": two["tenant_id"]})
    assert switched.status_code == 403
    assert (await rt.http.get("/v1/admin/routing-policies", headers=rt.headers(one))).status_code == 403
    for context, count in [(None, 0), (UUID(two["tenant_id"]), 0), (tenant, 1)]:
        async with rt.app.state.db.transaction(context) as conn:
            assert (
                await conn.scalar(
                    sa.select(sa.func.count())
                    .select_from(db.requests)
                    .where(db.requests.c.tenant_id == tenant)
                )
                == count
            )
    with pytest.raises(DBAPIError):
        async with rt.app.state.db.transaction(tenant) as conn:
            await conn.scalar(sa.select(db.api_keys.c.digest).where(db.api_keys.c.id == key))
    async with rt.admin.transaction() as conn:
        await lock_tenant(conn, tenant, exclusive=True)
        await conn.execute(
            sa.update(db.api_keys).where(db.api_keys.c.id == key).values(revoked_at=datetime.now(UTC))
        )
    revoked = await rt.http.post(CHAT, json=body(), headers=rt.headers(one))
    assert revoked.status_code == 401 and revoked.json()["error"]["code"] == "invalid_api_key"


async def test_http_parser_has_bounded_redacted_errors(runtime):
    rt = runtime
    seed = await rt.seed()
    headers = rt.headers(seed)
    payload = '{"model":"mock-chat","model":"secret","messages":[]}'
    invalid = await rt.http.post(
        CHAT, content=payload, headers={**headers, "Content-Type": "application/json"}
    )
    assert invalid.status_code == 400 and "secret" not in invalid.text
    assert invalid.json()["request_id"] == invalid.headers["x-request-id"]
    unsupported = await rt.http.post(CHAT, json=body(secret_field_disallowed=1), headers=headers)
    assert unsupported.status_code == 400 and unsupported.json()["error"]["code"] == "unsupported_parameter"
    assert "secret_field_disallowed" not in unsupported.text
    too_big = await rt.http.post(
        CHAT, content=b"x" * (128 * 1024 + 1), headers={**headers, "Content-Type": "application/json"}
    )
    assert too_big.status_code == 413
    encoded = await rt.http.post(CHAT, json=body(), headers={**headers, "Content-Encoding": "gzip"})
    assert encoded.status_code == 415


async def test_invalid_identity_does_not_consume_inference_body(runtime):
    read = False

    async def payload():
        nonlocal read
        read = True
        yield b'{"model":"mock-chat"}'

    for headers in ({}, {"Authorization": "Bearer ag_test_not_a_key"}):
        response = await runtime.http.post(
            CHAT, content=payload(), headers={**headers, "Content-Type": "application/json"}
        )
        assert response.status_code == 401
        assert not read


async def test_cors_allows_only_configured_origins_and_request_headers(runtime):
    trusted = "https://console.example.test"
    fit = create_app(runtime.settings.model_copy(update={"allowed_origins": [trusted]}))
    async with (
        fit.router.lifespan_context(fit),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=fit), base_url="http://test") as browser,
    ):
        headers = {
            "Origin": trusted,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type,x-tenant-id",
        }
        allowed = await browser.options(CHAT, headers=headers)
        assert allowed.status_code == 200 and allowed.headers["access-control-allow-origin"] == trusted
        assert "access-control-allow-credentials" not in allowed.headers
        foreign = await browser.options(CHAT, headers={**headers, "Origin": "https://foreign.invalid"})
        assert foreign.status_code == 400 and "access-control-allow-origin" not in foreign.headers
        rejected = await browser.options(
            CHAT, headers={**headers, "Access-Control-Request-Headers": "authorization,x-arbitrary-header"}
        )
        assert rejected.status_code == 400
        missing = await browser.post(CHAT, json=body(), headers={"Origin": trusted})
        assert missing.status_code == 401
        assert "x-request-id" in missing.headers["access-control-expose-headers"].lower()


async def test_unlisted_model_consumes_quota_across_gateway_replicas(runtime):
    rt = runtime
    seed, other = await rt.seed(), await rt.seed()
    tenant = UUID(seed["tenant_id"])
    controls = rt.app.state.gateway.controls
    # Set a deterministic two-request balance. A future tick prevents refill during the test.
    key = f"{controls.prefix}:{{t:{tenant}}}:rate:key:{seed['key_id']}:rpm"
    stamp, _ = await controls.redis.time()
    await controls.redis.hset(key, mapping={"credit": 120_000, "tick": (stamp + 30) * 1000})
    await controls.redis.expire(key, 60)
    twin = create_app(rt.settings)
    async with (
        twin.router.lifespan_context(twin),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=twin), base_url="http://replica") as remote,
    ):
        twin.state.gateway.controls.prefix = controls.prefix
        headers = rt.headers(seed)
        missing = await remote.post(CHAT, json=body("unlisted"), headers=headers)
        assert missing.status_code == 404
        responses = await asyncio.gather(
            *(client.post(CHAT, json=body(max_tokens=5), headers=headers) for client in (rt.http, remote))
        )
    assert sorted(response.status_code for response in responses) == [200, 429]
    limited = next(response for response in responses if response.status_code == 429)
    assert limited.json()["error"]["code"] == "rate_limit_exceeded"
    assert int(limited.headers["Retry-After"]) >= 1
    assert (await rt.http.post(CHAT, json=body(), headers=rt.headers(other))).status_code == 200


async def test_completed_error_is_recorded_as_failure_not_disconnect(runtime):
    rt = runtime
    seed = await rt.seed(cap=19)
    response = await rt.http.post(CHAT, json=body(max_tokens=5), headers=rt.headers(seed))
    assert response.status_code == 429 and response.json()["error"]["code"] == "budget_exceeded"
    r = db.requests.c
    async with rt.admin.transaction() as conn:
        state, reason = (
            await conn.execute(
                sa.select(r.state, r.reason).where(
                    r.tenant_id == UUID(seed["tenant_id"]), r.id == UUID(response.headers["x-request-id"])
                )
            )
        ).one()
    assert (state, reason) == ("failed", "budget_exceeded")


async def test_budget_denies_before_any_provider_attempt(runtime):
    rt = runtime
    seed = await rt.seed(cap=19)
    response = await rt.http.post(CHAT, json=body(max_tokens=5), headers=rt.headers(seed))
    assert response.status_code == 429 and response.json()["error"]["code"] == "budget_exceeded"
    async with rt.admin.transaction() as conn:
        assert (
            await conn.scalar(
                sa.select(sa.func.count())
                .select_from(db.attempts)
                .where(db.attempts.c.tenant_id == UUID(seed["tenant_id"]))
            )
            == 0
        )


async def test_near_cap_concurrency_cannot_oversubscribe(runtime):
    rt = runtime
    seed = await rt.seed(cap=40)
    tenant = UUID(seed["tenant_id"])
    chat = Chat.model_validate(body(max_tokens=5))
    gateway = rt.app.state.gateway
    actor = Principal(tenant, UUID(seed["key_id"]), "key", frozenset({"chat:write"}))
    policy = await gateway.catalog.active(tenant, chat.model, datetime.now(UTC))
    cap = asyncio.Semaphore(8)

    async def contender(index):
        async with cap:
            info = RequestInfo(uuid4(), datetime.now(UTC), monotonic() + 10, f"test-{index}")
            route = routing_decision(
                chat, policy, tenant, info.request_id, latency_class_for(chat, policy), {}, frozenset()
            )
            candidate = route.ranked[0]
            await gateway.accounting.admit(actor, info, chat, policy, route.evidence())
            try:
                return await gateway.accounting.reserve(actor, info, policy, candidate, 1)
            except GatewayError as exc:
                assert exc.code == "budget_exceeded"
                return None

    results = [item for item in await asyncio.gather(*(contender(i) for i in range(100))) if item is not None]
    assert len(results) == 2
    async with rt.admin.transaction() as conn:
        reserved, spent = (
            await conn.execute(
                sa.select(db.budget_periods.c.reserved, db.budget_periods.c.spent).where(
                    db.budget_periods.c.tenant_id == tenant
                )
            )
        ).one()
        hold = await conn.scalar(
            sa.select(sa.func.sum(db.ledger.c.hold_delta)).where(db.ledger.c.tenant_id == tenant)
        )
    assert (reserved, spent, hold) == (40, 0, 40)


@pytest.mark.parametrize(
    ("fixture", "ambiguous", "stream", "status", "states"),
    [
        ("fail-unsent", False, False, 200, ["confirmed_nonbillable", "reported"]),
        ("fail-ambiguous", False, False, 502, ["pending"]),
        ("fail-ambiguous", True, True, 200, ["pending", "reported"]),
        ("fail-after-text", True, True, 200, ["pending"]),
        ("missing-usage", True, True, 200, ["pending"]),
    ],
)
async def test_fallback_and_stream_commit_rules(runtime, fixture, ambiguous, stream, status, states):
    rt = runtime
    seed = await rt.seed()
    tenant = UUID(seed["tenant_id"])
    route = await fixture_route(rt, tenant, fixture, ambiguous=ambiguous)
    response = await rt.http.post(
        CHAT,
        json=body(
            route,
            stream=stream,
            max_tokens=5,
            **({"stream_options": {"include_usage": True}} if stream else {}),
        ),
        headers=rt.headers(seed),
    )
    assert response.status_code == status, response.text
    if stream:
        if fixture == "fail-after-text":
            assert "Aegis partial" in response.text and "event: error" in response.text
            assert "[DONE]" not in response.text
        else:
            assert response.text.count("[DONE]") == 1
    rows, period = await records(rt, tenant, UUID(response.headers["x-request-id"]))
    assert [row["state"] for row in rows] == states
    assert period["reserved"] == sum(row["hold"] for row in rows if row["state"] == "pending")
    assert period["spent"] == sum(row["charged"] for row in rows)


async def test_retry_checks_combined_request_exposure(runtime):
    rt = runtime
    seed = await rt.seed()
    tenant = UUID(seed["tenant_id"])
    alias = await fixture_route(rt, tenant, "fail-ambiguous", ambiguous=True, cap="25")
    result = await rt.http.post(CHAT, json=body(alias, max_tokens=5), headers=rt.headers(seed))
    assert result.status_code == 502, result.text
    rows, period = await records(rt, tenant, UUID(result.headers["x-request-id"]))
    assert len(rows) == 1 and period["reserved"] == 20


async def test_redis_rate_lease_and_half_open_are_distributed(runtime):
    rt = runtime
    seed = await rt.seed()
    tenant = UUID(seed["tenant_id"])
    actor = Principal(tenant, UUID(seed["key_id"]), "key", frozenset({"chat:write"}))
    one = rt.app.state.gateway.controls
    two = Controls(rt.settings, prefix=one.prefix)
    try:

        async def debit(controls):
            try:
                await controls.debit(actor, 10)
                return True
            except GatewayError as exc:
                assert exc.code == "rate_limit_exceeded" and exc.retry_after >= 1
                return False

        grants = await asyncio.gather(*(debit(one if i % 2 else two) for i in range(20)))
        assert sum(grants) == 3  # Cold key starts with one quarter of a 15-request burst.
        lease = await one.acquire(f"t:{tenant}", 1)
        assert lease and await two.acquire(f"t:{tenant}", 1) is None
        await lease.close()
        successor = await two.acquire(f"t:{tenant}", 1)
        assert successor
        await successor.close()
        route = (await rt.app.state.catalog.active(tenant, "mock-chat", datetime.now(UTC))).deployments[0]
        original = await one.grant(route, 15)
        for _ in range(10):
            grant = await one.grant(route, 15)
            assert not grant.probe
            await two.feedback(route, grant, True)
        assert await two.probe_state(route) == "open"
        await one.redis.hset(one._breaker_key(route), "until", 0)
        racing = await asyncio.gather(*(controller.grant(route, 15) for controller in (one, two, one, two)))
        probes = [grant for grant in racing if grant is not None]
        assert len(probes) == 1 and probes[0].probe
        await one.feedback(route, original, False)
        assert await two.probe_state(route) == "half_open"
        await two.feedback(route, probes[0], False)
        assert await one.probe_state(route) == "closed"
        active = await one.grant(route, 5)
        await one.feedback(route, active, True, cooldown=30)
        sibling = replace(route, id=uuid4())
        unrelated = replace(route, id=uuid4(), quota_group="unrelated")
        assert await two.probe_state(sibling) == "cooldown" and await two.grant(sibling, 5) is None
        assert await two.probe_state(unrelated) == "closed"
    finally:
        await two.close()


async def test_worker_recovery_preserves_then_settles_and_adjusts(runtime):
    if "AEGIS_TEST_WORKER_URL" not in os.environ:
        pytest.skip("Provide the disposable worker role URL.")
    rt = runtime
    seed = await rt.seed()
    tenant = UUID(seed["tenant_id"])
    alias = await fixture_route(rt, tenant, "missing-usage")
    response = await rt.http.post(CHAT, json=body(alias, max_tokens=8), headers=rt.headers(seed))
    request = UUID(response.headers["x-request-id"])
    assert response.json()["usage"] is None
    rows, before = await records(rt, tenant, request)
    attempt = rows[0]["id"]
    past = datetime.now(UTC) - timedelta(seconds=1)
    async with rt.admin.transaction() as conn:
        await conn.execute(
            sa.update(db.attempts)
            .where(db.attempts.c.id == attempt)
            .values(state="authorized", lease_expires_at=past, settle_after=past)
        )
        await conn.execute(
            sa.update(db.requests)
            .where(db.requests.c.id == request)
            .values(state="admitted", delivery="unknown")
        )
    recovery = Database(rt.settings, os.environ["AEGIS_TEST_WORKER_URL"])
    try:
        await recovery.verify("aegis_worker")
        worker = Accounting(recovery)
        await asyncio.gather(worker.reconcile(), worker.reconcile())
        await worker.reconcile()
    finally:
        await recovery.close()
    rows, after = await records(rt, tenant, request)
    assert rows[0]["state"] == "estimated" and after["spent"] == before["reserved"] and after["reserved"] == 0
    correction = uuid4()
    ops = Accounting(rt.admin)
    reported = TokenUsage(prompt_tokens=10, completion_tokens=5)
    assert await ops.adjust(tenant, attempt, correction, reported, "Fixture evidence", "test operator")
    assert not await ops.adjust(tenant, attempt, correction, reported, "Fixture evidence", "test operator")
    rows, after = await records(rt, tenant, request)
    assert rows[0]["state"] == "adjusted" and after["spent"] == 20


async def test_oidc_routing_policy_optimistic_update(runtime):
    rt = runtime
    seed = await rt.seed()
    tenant = UUID(seed["tenant_id"])
    subject, user = "member-" + uuid4().hex, uuid4()
    async with rt.admin.transaction() as conn:
        await conn.execute(
            sa.insert(db.users).values(id=user, issuer=rt.settings.oidc_issuer, subject=subject)
        )
        await conn.execute(sa.insert(db.memberships).values(tenant_id=tenant, user_id=user, role="admin"))
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
    auth = rt.app.state.auth
    auth.jwks["fixture"] = jwt.PyJWK.from_dict(jwk, algorithm="RS256")
    auth.cached_at = monotonic()

    def sign(audience, *, expires_in=300):
        now = int(datetime.now(UTC).timestamp())
        return jwt.encode(
            {
                "iss": rt.settings.oidc_issuer,
                "aud": audience,
                "sub": subject,
                "iat": now - 60,
                "exp": now + expires_in,
            },
            private,
            algorithm="RS256",
            headers={"kid": "fixture", "typ": "at+jwt"},
        )

    headers = {"X-Tenant-ID": str(tenant), "Authorization": "Bearer " + sign(rt.settings.oidc_audience)}
    path = "/v1/admin/routing-policies"
    rejected = await rt.http.get(
        path, headers={**headers, "Authorization": "Bearer " + sign("wrong-audience")}
    )
    assert rejected.status_code == 401
    expired = await rt.http.get(
        path,
        headers={**headers, "Authorization": "Bearer " + sign(rt.settings.oidc_audience, expires_in=-30)},
    )
    assert expired.status_code == 401
    response = await rt.http.get(path, params={"model": "mock-chat"}, headers=headers)
    assert response.status_code == 200, response.text
    policy = response.json()["data"][0]
    current_catalog = (
        await rt.app.state.catalog.active(tenant, "mock-chat", datetime.now(UTC))
    ).catalog_revision
    change = {
        "model": "mock-chat",
        "expected_revision": policy["revision"],
        "catalog_revision": current_catalog,
        "targets": policy["targets"],
        "data_regions": ["local"],
        "change_reason": "Test optimistic version",
    }
    results = await asyncio.gather(*(rt.http.post(path, json=change, headers=headers) for _ in range(2)))
    assert sorted(item.status_code for item in results) == [201, 409], [item.text for item in results]


async def test_downstream_disconnect_closes_upstream_without_replay(runtime):
    rt = runtime
    seed = await rt.seed()
    tenant = UUID(seed["tenant_id"])
    provider_closed = asyncio.Event()

    class SlowMock(Mock):
        async def stream(self, deployment, chat):
            try:
                yield ProviderEvent(text="first text")
                await asyncio.sleep(60)
            finally:
                provider_closed.set()

    rt.app.state.gateway.providers["mock"] = SlowMock()
    raw = json.dumps(body(stream=True, max_tokens=5)).encode()
    incoming = asyncio.Queue()
    await incoming.put({"type": "http.request", "body": raw, "more_body": False})
    output = []

    async def send(message):
        output.append(message)
        if b"first text" in message.get("body", b""):
            await incoming.put({"type": "http.disconnect"})

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": CHAT,
        "raw_path": CHAT.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"authorization", ("Bearer " + seed["api_key"]).encode()),
            (b"content-type", b"application/json"),
        ],
        "client": ("127.0.0.1", 8123),
        "server": ("test", 80),
    }
    async with asyncio.timeout(3):
        await rt.app(scope, incoming.get, send)
    assert provider_closed.is_set() and not any(b"[DONE]" in item.get("body", b"") for item in output)
    identity = dict(output[0]["headers"])[b"x-request-id"].decode()
    attempts, account = await records(rt, tenant, UUID(identity))
    assert len(attempts) == 1 and attempts[0]["state"] == "pending" and account["reserved"] == 20
    controls = rt.app.state.gateway.controls
    assert await controls.redis.zcard(f"{controls.prefix}:{{t:{tenant}}}:flight") == 0


async def test_redis_outage_fails_closed(runtime):
    rt = runtime
    seed = await rt.seed()
    svc = rt.app.state.gateway
    old = svc.controls
    svc.controls = Controls(
        rt.settings.model_copy(update={"redis_url": type(rt.settings.redis_url)("redis://127.0.0.1:1/0")})
    )
    try:
        response = await rt.http.post(CHAT, json=body(), headers=rt.headers(seed))
        ready = await rt.http.get("/v1/health")
        assert response.status_code == 503 and response.json()["error"]["code"] == "admission_unavailable"
        assert ready.status_code == 503
    finally:
        await svc.controls.close()
        svc.controls = old


@pytest.mark.parametrize("commit", [False, True])
async def test_stream_phase_deadline(runtime, commit):
    rt = runtime
    seed = await rt.seed()
    service = rt.app.state.gateway
    service.settings = service.settings.model_copy(
        update={"stream_first_deadline": 0.05, "stream_idle_deadline": 0.05}
    )

    class Stalled(Mock):
        async def stream(self, deployment, chat):
            if commit:
                yield ProviderEvent(text="already streamed")
            await asyncio.sleep(30)
            yield ProviderEvent(finish="stop")

    service.providers["mock"] = Stalled()
    response = await rt.http.post(CHAT, json=body(stream=True, max_tokens=5), headers=rt.headers(seed))
    assert response.status_code == (200 if commit else 504), response.text
    assert "provider_timeout" in response.text and "[DONE]" not in response.text
    assert ("event: error" in response.text) == commit
    rows, period = await records(rt, UUID(seed["tenant_id"]), UUID(response.headers["x-request-id"]))
    assert len(rows) == 1 and rows[0]["state"] == "pending" and period["reserved"] == 20


async def test_accounting_failure_after_stream_commit_keeps_reservation(runtime, monkeypatch):
    rt = runtime
    seed = await rt.seed()
    service = rt.app.state.gateway

    async def database_unavailable(*args, **kwargs):
        from sqlalchemy.exc import OperationalError

        raise OperationalError("settle", None, RuntimeError("simulated failure"))

    monkeypatch.setattr(service.accounting, "outcome", database_unavailable)
    response = await rt.http.post(CHAT, json=body(stream=True, max_tokens=5), headers=rt.headers(seed))
    assert response.status_code == 200 and "event: error" in response.text
    assert "accounting_unavailable" in response.text and "[DONE]" not in response.text
    rows, period = await records(rt, UUID(seed["tenant_id"]), UUID(response.headers["x-request-id"]))
    assert len(rows) == 1 and rows[0]["state"] == "authorized" and period["reserved"] == 20


async def test_month_rollover_keeps_attempt_and_settlement_in_original_period(runtime):
    rt = runtime
    seed = await rt.seed()
    service = rt.app.state.gateway
    tenant = UUID(seed["tenant_id"])
    boundary = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    received = boundary - timedelta(seconds=1)
    month = utc_month(received)
    async with rt.admin.transaction() as conn:
        await conn.execute(
            sa.update(db.budget_policies)
            .where(db.budget_policies.c.tenant_id == tenant)
            .values(effective_month=month)
        )
    actor = Principal(tenant, UUID(seed["key_id"]), "key", frozenset({"chat:write"}))
    info = RequestInfo(uuid4(), received, monotonic() + 5, None)
    chat = Chat.model_validate(body(max_tokens=5))
    policy = await service.catalog.active(tenant, chat.model, datetime.now(UTC))
    decision = routing_decision(chat, policy, tenant, info.request_id, "standard", {}, frozenset())
    await service.accounting.admit(actor, info, chat, policy, decision.evidence())
    attempt = await service.accounting.reserve(actor, info, policy, decision.ranked[0], 1)
    await service.accounting.outcome(
        attempt, success=True, reason="stop", usage=TokenUsage(prompt_tokens=10, completion_tokens=5)
    )
    rows, budget = await records(rt, tenant, info.request_id)
    assert rows[0]["period_start"] == budget["period_start"] == month
    assert budget["spent"] == 20 and budget["reserved"] == 0


async def test_trace_correlates_without_credentials_or_prompt(runtime, capfd):
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    rt = runtime
    seed = await rt.seed()
    exporter = InMemorySpanExporter()
    rt.app.state.telemetry.provider.add_span_processor(SimpleSpanProcessor(exporter))
    prompt = "canary-prompt-unique-to-this-request"
    response = await rt.http.post(
        CHAT,
        json=body(messages=[{"role": "user", "content": prompt}], max_tokens=5),
        headers=rt.headers(seed),
    )
    assert response.status_code == 200
    spans = exporter.get_finished_spans()
    assert {
        "aegis.http",
        "aegis.auth",
        "aegis.route",
        "aegis.reserve",
        "aegis.provider_attempt",
        "aegis.settle",
    } <= {span.name for span in spans}
    http_span = next(span for span in spans if span.name == "aegis.http")
    assert http_span.attributes["aegis.request_id"] == response.headers["x-request-id"]
    assert all(item.context.trace_id == http_span.context.trace_id for item in spans)
    payload = "".join(item.to_json() for item in spans) + capfd.readouterr().err
    assert seed["api_key"] not in payload and prompt not in payload
