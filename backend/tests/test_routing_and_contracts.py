from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from aegis.api import create_app
from aegis.contracts import Chat, Deployment, Policy, PolicyConfig, TokenUsage
from aegis.errors import GatewayError
from aegis.queries import Cursors
from aegis.reliability import HealthSignal
from aegis.routing import estimated_cost, routing_decision, usage_components

MESSAGE = [{"role": "user", "content": "hello"}]


def deployment(number: int = 1) -> Deployment:
    return Deployment(
        id=UUID(int=number),
        version=1,
        provider="mock",
        name=f"mock-{number}",
        upstream_model="mock-v1",
        region="local",
        quality=0,
        context_limit=32768,
        output_limit=2048,
        capabilities=frozenset({"text", "system", "stream", "temperature", "top_p", "stop"}),
        rates={"input": 1_000_000, "output": 2_000_000, "cache_read": 100_000, "cache_write": 3_000_000},
        price_version=1,
        certified=True,
        credential_ref=None,
        credential_revision=1,
        quota_group=f"group-{number}",
        stream_baseline_ms=100,
        json_baseline_ms=100,
        bound_overhead=0,
    )


def policy_for(items: list[Deployment], **overrides) -> Policy:
    config = PolicyConfig(
        targets=[{"deployment_id": d.id, "priority": 50, "weight": 50} for d in items],
        data_regions=["local"],
        **overrides,
    )
    return Policy(UUID(int=20), UUID(int=21), UUID(int=22), 1, 1, config, items, 10000)


@pytest.mark.parametrize(
    "change",
    [
        {"stream": "true"},
        {"stream_options": {"include_usage": True}},
        {"tools": []},
        {"n": True},
        {"max_completion_tokens": 1, "max_tokens": 2},
        {"temperature": 0.2, "top_p": 0.8},
        {"temperature": float("inf")},
        {"stop": [""]},
        {"stop": ["α" * 65]},
        {"messages": [{"role": "user", "content": "\ud800"}]},
        {"messages": [{"role": "assistant", "content": "no"}]},
        {"temperature": None},
    ],
)
def test_chat_schema_rejects_invalid_input(change):
    with pytest.raises(ValidationError):
        Chat.model_validate({"model": "mock-chat", "messages": MESSAGE, **change})


def test_cost_components_and_maximum():
    chat = Chat(model="mock-chat", messages=MESSAGE, max_tokens=5)
    route = deployment()
    assert estimated_cost(chat, route) == (20, 40)
    use = TokenUsage(prompt_tokens=10, completion_tokens=3, cache_read=2, cache_write=1)
    assert usage_components(use, route.rates) == {
        "input": (7, 7),
        "output": (3, 6),
        "cache_read": (2, 1),
        "cache_write": (1, 3),
    }


def test_deterministic_ranking_weighting_and_policy_denials():
    good, other, wrong = deployment(1), deployment(2), replace(deployment(3), region="denied")
    chat = Chat(model="auto", messages=MESSAGE)
    policy = policy_for([other, good, wrong], enable_weighted=True)
    params = chat, policy, UUID(int=30), UUID(int=33), "standard", {}, frozenset()
    decision = routing_decision(*params)
    assert [item.deployment.id for item in decision.ranked] == [good.id, other.id]
    assert decision.reject_reasons == {"policy": 1}
    assert decision == routing_decision(*params)
    assert decision.weighted == other.id
    assert decision.initial()[0].deployment.id == other.id


def test_health_deadline_and_quality_gates():
    d = deployment()
    chat = Chat(model="auto", messages=MESSAGE)
    policy = policy_for([d], enforce_predicted_ceiling=True)
    signals = {d.id: HealthSignal(17000, 0, 32)}
    args = policy, uuid4(), uuid4(), "standard", signals, frozenset()
    assert routing_decision(chat, *args).reject_reasons == {"deadline": 1}
    complex_chat = Chat(model="auto", messages=MESSAGE, max_tokens=1024)
    assert routing_decision(complex_chat, *args).reject_reasons == {"policy": 1}


def test_external_uncertified_is_excluded_under_hard_cap():
    d = replace(deployment(), provider="openai", certified=False, credential_ref="test-ref")
    chat = Chat(model="auto", messages=MESSAGE)
    policy = policy_for([d])
    args = uuid4(), uuid4(), "standard", {}, frozenset({"test-ref"})
    assert routing_decision(chat, policy, *args).reject_reasons == {"uncertified": 1}
    assert routing_decision(chat, replace(policy, period_cap=None), *args).ranked


def test_policy_cycle_rejected():
    one, two = deployment(1), deployment(2)
    with pytest.raises(ValidationError):
        policy_for(
            [one, two],
            fallback_edges=[
                {"source": one.id, "target": two.id},
                {"source": two.id, "target": one.id},
            ],
        )


def test_cursor_integrity_tenant_filters_and_expiry(settings):
    cursors = Cursors(settings.cursor_secret.get_secret_value())
    tenant, now = uuid4(), datetime.now(UTC)
    token = cursors.issue(tenant, "usage", {"x": 1}, now, ["date", "model"])
    assert cursors.read(token, tenant, "usage", {"x": 1}) == (now, ["date", "model"])
    with pytest.raises(GatewayError, match="invalid_cursor"):
        cursors.read(token, uuid4(), "usage", {"x": 1})
    with pytest.raises(GatewayError, match="invalid_cursor"):
        cursors.read(token, tenant, "usage", {"x": 2})
    with pytest.raises(GatewayError, match="invalid_cursor"):
        cursors.read("a" + token[1:], tenant, "usage", {"x": 1})
    old = datetime.fromtimestamp(1, UTC)
    with pytest.raises(GatewayError, match="cursor_expired"):
        cursors.read(cursors.issue(tenant, "usage", {}, old, []), tenant, "usage", {})


def test_openapi_contains_chat_stream_and_policy_schemas(settings):
    schema = create_app(settings).openapi()
    chat = schema["paths"]["/v1/chat/completions"]["post"]
    assert "text/event-stream" in chat["responses"]["200"]["content"]
    assert chat["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/Chat"
    }
    assert "Message" in schema["components"]["schemas"]
    assert schema["paths"]["/v1/admin/routing-policies"]["post"]["security"] == [{"bearer": []}]
