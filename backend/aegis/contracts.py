from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

LatencyClass = Literal["standard", "interactive", "batch"]
Finish = Literal["stop", "length", "content_filter"]
Alias = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9:_./-]*$")]
Money = Annotated[str, Field(pattern=r"^[1-9][0-9]{0,14}$")]
Revision = Annotated[int, Field(ge=0, le=2**53 - 1)]
Weight = Annotated[int, Field(ge=0, le=100)]
TokenLimit = Annotated[int, Field(ge=1, le=2048)]
LATENCY_CLASSES = ("standard", "interactive", "batch")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


def text_size(value: str) -> int:
    size = len(value.encode("utf-8", errors="strict"))
    if "\0" in value:
        raise ValueError("NUL is not allowed")
    return size


class Message(StrictModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=65536)

    @field_validator("content")
    @classmethod
    def check_size(cls, value: str) -> str:
        if text_size(value) > 65536:
            raise ValueError("message exceeds byte limit")
        return value


class StreamOptions(StrictModel):
    include_usage: bool = False


class GatewayOptions(StrictModel):
    latency_class: LatencyClass | None = None


class Chat(StrictModel):
    model: Alias
    messages: list[Message] = Field(min_length=1, max_length=64)
    stream: bool = False
    max_completion_tokens: TokenLimit | None = None
    max_tokens: TokenLimit | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    stop: str | list[str] | None = None
    n: int = Field(default=1, ge=1, le=1)
    stream_options: StreamOptions | None = None
    aegis: GatewayOptions | None = None

    @model_validator(mode="after")
    def check_shape(self) -> Self:
        if any(getattr(self, field) is None for field in self.model_fields_set - {"aegis"}):
            raise ValueError("explicit null is unsupported")
        roles = [message.role for message in self.messages]
        if roles[0] == "system":
            roles = roles[1:]
        if not roles or roles[0] != "user" or roles[-1] != "user" or "system" in roles:
            raise ValueError("invalid message order")
        if self.max_tokens is not None and self.max_completion_tokens is not None:
            raise ValueError("set one output limit")
        if self.temperature is not None and self.top_p is not None:
            raise ValueError("set one sampling control")
        if self.stream_options and not self.stream:
            raise ValueError("stream_options requires streaming")
        if self.aegis is not None and self.model != "auto":
            raise ValueError("routing extension requires auto")
        if self.stop is not None:
            stops = [self.stop] if isinstance(self.stop, str) else self.stop
            if not 1 <= len(stops) <= 4 or any(not 1 <= text_size(item) <= 128 for item in stops):
                raise ValueError("invalid stop strings")
        return self

    @property
    def output_ceiling(self) -> int:
        return self.max_completion_tokens or self.max_tokens or 256

    @property
    def message_bytes(self) -> int:
        return sum(text_size(message.content) for message in self.messages)

    @property
    def prompt_quota(self) -> int:
        return (self.message_bytes + 3) // 4 + 8 * len(self.messages)

    @property
    def min_quality(self) -> int:
        return int(
            (self.message_bytes + 3) // 4 > 3500 or len(self.messages) >= 9 or self.output_ceiling >= 1024
        )


class Weights(StrictModel):
    cost: Weight = 35
    latency: Weight = 30
    reliability: Weight = 25
    priority: Weight = 10

    @model_validator(mode="after")
    def check_total(self) -> Self:
        if sum((self.cost, self.latency, self.reliability, self.priority)) != 100:
            raise ValueError("weights must sum to 100")
        return self


class Target(StrictModel):
    deployment_id: UUID
    priority: Weight
    weight: Weight


class Edge(StrictModel):
    source: UUID
    target: UUID


class PolicyConfig(StrictModel):
    targets: list[Target] = Field(min_length=1, max_length=8)
    fallback_edges: list[Edge] = Field(max_length=56, default_factory=list)
    weights: Weights = Field(default_factory=Weights)
    weighted_band: int = Field(default=0, ge=0, le=50000)
    enable_weighted: bool = False
    cost_reference_microusd: Money = "20000"
    max_request_cost_microusd: Money | None = None
    allow_ambiguous_failover: bool = False
    data_regions: list[Annotated[str, Field(pattern=r"^[a-z0-9-]{1,32}$")]] = Field(
        min_length=1, max_length=16
    )
    default_latency_class: LatencyClass = "standard"
    allowed_latency_classes: list[LatencyClass] = Field(
        min_length=1, max_length=3, default_factory=lambda: ["standard"]
    )
    enforce_predicted_ceiling: bool = False

    @model_validator(mode="after")
    def check_policy(self) -> Self:
        target_ids = {t.deployment_id for t in self.targets}
        if len(target_ids) != len(self.targets):
            raise ValueError("duplicate targets")
        for values in (self.data_regions, self.allowed_latency_classes):
            if len(set(values)) != len(values):
                raise ValueError("duplicate policy choices")
        if self.default_latency_class not in self.allowed_latency_classes:
            raise ValueError("default class is not allowed")
        graph: dict[UUID, set[UUID]] = {item: set() for item in target_ids}
        for edge in self.fallback_edges:
            if edge.source not in graph or edge.target not in graph or edge.target in graph[edge.source]:
                raise ValueError("invalid or duplicate fallback edge")
            graph[edge.source].add(edge.target)

        def visit(node: UUID, ancestors: frozenset[UUID]) -> None:
            if node in ancestors:
                raise ValueError("fallback graph has a cycle")
            for successor in graph[node]:
                visit(successor, ancestors | {node})

        for node in graph:
            visit(node, frozenset())
        return self


class PolicyChange(StrictModel):
    model: Alias
    expected_revision: Revision
    catalog_revision: Revision
    status: Literal["active", "disabled"] = "active"
    change_reason: str

    @field_validator("change_reason")
    @classmethod
    def check_reason(cls, value: str) -> str:
        value = value.strip()
        if not 1 <= text_size(value) <= 256:
            raise ValueError("invalid change reason")
        return value


class ActivePolicyChange(PolicyChange, PolicyConfig):
    status: Literal["active"] = "active"


class DisabledPolicyChange(PolicyChange):
    status: Literal["disabled"]


class TokenUsage(BaseModel):
    model_config = ConfigDict(strict=True)
    prompt_tokens: int = Field(ge=0, le=10_000_000)
    completion_tokens: int = Field(ge=0, le=10_000_000)
    cache_read: int = Field(default=0, ge=0, le=10_000_000)
    cache_write: int = Field(default=0, ge=0, le=10_000_000)

    @model_validator(mode="after")
    def check_components(self) -> Self:
        if self.cache_read + self.cache_write > self.prompt_tokens:
            raise ValueError("cache components exceed prompt")
        return self

    def public(self) -> dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
        }

    def components(self) -> dict[str, int]:
        return {
            "input": self.prompt_tokens - self.cache_read - self.cache_write,
            "output": self.completion_tokens,
            "cache_read": self.cache_read,
            "cache_write": self.cache_write,
        }


class PublicUsage(StrictModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class AssistantMessage(StrictModel):
    role: Literal["assistant"]
    content: str | None


class ChatChoice(StrictModel):
    index: Literal[0]
    message: AssistantMessage
    finish_reason: Finish
    logprobs: None = None


class ChatCompletion(StrictModel):
    id: str
    object: Literal["chat.completion"]
    created: int
    model: str
    choices: list[ChatChoice]
    usage: PublicUsage | None


class ModelEntry(StrictModel):
    id: str
    object: Literal["model"] = "model"
    created: int
    owned_by: Literal["aegis"] = "aegis"


class ModelList(StrictModel):
    object: Literal["list"] = "list"
    data: list[ModelEntry]


class Health(StrictModel):
    status: Literal["ok", "degraded", "unavailable"]
    request_id: UUID


@dataclass(frozen=True, slots=True)
class Principal:
    tenant_id: UUID
    actor_id: UUID
    kind: Literal["key", "user"]
    scopes: frozenset[str]
    key_public_id: str | None = None


@dataclass(frozen=True, slots=True)
class RequestInfo:
    request_id: UUID
    received_at: datetime
    deadline: float
    client_request_id: str | None
    started: float | None = None


@dataclass(frozen=True, slots=True)
class ProviderResult:
    text: str | None
    finish: Finish
    usage: TokenUsage | None


@dataclass(frozen=True, slots=True)
class ProviderEvent:
    text: str | None = None
    finish: Finish | None = None
    usage: TokenUsage | None = None


@dataclass(frozen=True, slots=True)
class Deployment:
    id: UUID
    version: int
    provider: Literal["mock", "openai", "anthropic"]
    name: str
    upstream_model: str
    region: str
    quality: int
    context_limit: int
    output_limit: int
    capabilities: frozenset[str]
    rates: dict[str, int]
    price_version: int
    certified: bool
    credential_ref: str | None
    credential_revision: int
    quota_group: str
    stream_baseline_ms: int
    json_baseline_ms: int
    bound_overhead: int


@dataclass(frozen=True, slots=True)
class Policy:
    id: UUID
    version_id: UUID
    alias_id: UUID
    revision: int
    catalog_revision: int
    config: PolicyConfig
    deployments: Sequence[Deployment]
    period_cap: int | None
