from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256
from uuid import UUID

from aegis.contracts import Chat, Deployment, LatencyClass, Policy, TokenUsage
from aegis.errors import GatewayError
from aegis.reliability import HealthSignal

TARGETS = {"standard": (8000, 2500), "interactive": (5000, 1500), "batch": (20000, 5000)}


def price(tokens: int, rate: int) -> int:
    return (tokens * rate + 999_999) // 1_000_000


def usage_components(usage: TokenUsage, rates: Mapping[str, int]) -> dict[str, tuple[int, int]]:
    return {unit: (tokens, price(tokens, rates[unit])) for unit, tokens in usage.components().items()}


def prompt_bound(chat: Chat, deployment: Deployment) -> int:
    if deployment.provider == "mock":
        return chat.prompt_quota
    # The bytes-plus-envelope bound is operational only, unless enrollment attests to its billing coverage.
    return chat.message_bytes + deployment.bound_overhead + 16 * len(chat.messages)


def estimated_cost(chat: Chat, d: Deployment) -> tuple[int, int]:
    predicted = min(chat.output_ceiling, max(32, (chat.prompt_quota + 3) // 4))
    estimate = price(chat.prompt_quota, d.rates["input"]) + price(predicted, d.rates["output"])
    # Splitting input into mutually exclusive cache units can add two units of rounding.
    input_amount = price(
        prompt_bound(chat, d), max(d.rates[u] for u in ("input", "cache_read", "cache_write"))
    )
    rounding = (
        2
        if d.provider != "mock" and input_amount and (d.rates["cache_read"] or d.rates["cache_write"])
        else 0
    )
    return estimate, input_amount + rounding + price(chat.output_ceiling, d.rates["output"])


def latency_class_for(chat: Chat, policy: Policy) -> LatencyClass:
    latency_class = chat.aegis.latency_class if chat.aegis else None
    resolved = latency_class or policy.config.default_latency_class
    if resolved not in policy.config.allowed_latency_classes:
        raise GatewayError(403, "tenant_forbidden", "The latency class is not permitted by tenant policy.")
    return resolved


@dataclass(frozen=True, slots=True)
class Candidate:
    deployment: Deployment
    priority: int
    weight: int
    score: int
    estimate: int
    hold: int
    samples: int


@dataclass(frozen=True, slots=True)
class RoutingDecision:
    ranked: tuple[Candidate, ...]
    reject_reasons: dict[str, int]
    weighted: UUID | None

    def initial(self) -> list[Candidate]:
        if not self.weighted:
            return list(self.ranked)
        return sorted(self.ranked, key=lambda item: item.deployment.id != self.weighted)

    def evidence(self) -> dict:
        return {
            "algorithm": "aegis-route-v1",
            "weighted": str(self.weighted) if self.weighted else None,
            "rejects": self.reject_reasons,
            "ranks": [
                {
                    "deployment": str(item.deployment.id),
                    "rank": i,
                    "score": item.score,
                    "estimate": item.estimate,
                    "hold": item.hold,
                    "samples": item.samples,
                }
                for i, item in enumerate(self.ranked[:3], 1)
            ],
        }


def routing_decision(
    chat: Chat,
    policy: Policy,
    tenant: UUID,
    request: UUID,
    latency_class: LatencyClass,
    signals: Mapping[UUID, HealthSignal],
    credentials: frozenset[str],
) -> RoutingDecision:
    cfg = policy.config
    limit = TARGETS[latency_class][int(chat.stream)]
    targets = {target.deployment_id: target for target in cfg.targets}
    ranked = []
    rejected: Counter[str] = Counter()
    for d in policy.deployments:
        if d.region not in cfg.data_regions or (chat.model == "auto" and d.quality < chat.min_quality):
            rejected["policy"] += 1
            continue
        if d.provider != "mock" and d.credential_ref not in credentials:
            rejected["credential"] += 1
            continue
        required = {
            "text": True,
            "stream": chat.stream,
            "system": chat.messages[0].role == "system",
            "stop": chat.stop is not None,
            "temperature": chat.temperature is not None,
            "top_p": chat.top_p is not None,
        }
        if any(required[capability] and capability not in d.capabilities for capability in required):
            rejected["capability"] += 1
            continue
        if d.provider == "anthropic" and chat.temperature is not None and chat.temperature > 1:
            rejected["capability"] += 1
            continue
        if (
            prompt_bound(chat, d) > 16_384
            or prompt_bound(chat, d) + chat.output_ceiling > d.context_limit
            or chat.output_ceiling > d.output_limit
        ):
            rejected["context"] += 1
            continue
        if (policy.period_cap is not None or cfg.max_request_cost_microusd) and not d.certified:
            rejected["uncertified"] += 1
            continue
        estimate, hold = estimated_cost(chat, d)
        if cfg.max_request_cost_microusd and hold > int(cfg.max_request_cost_microusd):
            rejected["request_cap"] += 1
            continue
        signal = signals.get(d.id, HealthSignal(d.stream_baseline_ms if chat.stream else d.json_baseline_ms))
        if cfg.enforce_predicted_ceiling and signal.p95_ms > 2 * limit:
            rejected["deadline"] += 1
            continue
        target = targets[d.id]
        penalties = (
            min(10000, 10000 * estimate // int(cfg.cost_reference_microusd)),
            min(10000, 10000 * signal.p95_ms // (2 * limit)),
            min(10000, 10000 * signal.bad_ppm // 100000),
            10000 - 100 * target.priority,
        )
        weights = (cfg.weights.cost, cfg.weights.latency, cfg.weights.reliability, cfg.weights.priority)
        ranked.append(
            Candidate(
                d,
                target.priority,
                target.weight,
                sum(p * w for p, w in zip(penalties, weights, strict=True)),
                estimate,
                hold,
                signal.samples,
            )
        )
    ranked.sort(key=lambda item: (item.score, -item.priority, item.deployment.id.bytes))
    weighted = None
    if cfg.enable_weighted and ranked:
        eligible = [
            item for item in ranked if item.weight > 0 and item.score <= ranked[0].score + cfg.weighted_band
        ]
        if eligible:
            seed = b"aegis-route-v1" + tenant.bytes + request.bytes + policy.alias_id.bytes
            seed += policy.revision.to_bytes(8, "big")
            scale = int.from_bytes(sha256(seed).digest()[:8], "big")
            slot = (scale * sum(item.weight for item in eligible)) >> 64
            for item in sorted(eligible, key=lambda item: item.deployment.id.bytes):
                slot -= item.weight
                if slot < 0:
                    weighted = item.deployment.id
                    break
    return RoutingDecision(tuple(ranked), dict(rejected), weighted)


def empty_route_error(decision: RoutingDecision) -> GatewayError:
    causes = set(decision.reject_reasons)
    if causes and causes <= {"request_cap", "uncertified", "capability", "context", "policy"}:
        if "request_cap" in causes or "uncertified" in causes:
            return GatewayError(
                403, "request_cost_limit_exceeded", "No compatible deployment meets the spend policy."
            )
        if "context" in causes:
            return GatewayError(
                400, "context_length_exceeded", "The request exceeds the eligible model limits."
            )
        if "capability" in causes or "policy" in causes:
            return GatewayError(
                400, "unsupported_model_capability", "No enrolled deployment supports the request."
            )
    return GatewayError(503, "no_healthy_route", "No eligible healthy deployment is available.")
