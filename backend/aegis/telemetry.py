import json
import logging
from contextvars import ContextVar
from datetime import UTC, datetime

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from opentelemetry.trace import SpanKind
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

from aegis.settings import RuntimeSettings

request_context: ContextVar[str | None] = ContextVar("request_id", default=None)
logger = logging.getLogger("aegis")
FIELDS = {"route", "status", "mode", "duration_ms", "outcome", "provider", "count", "code"}
METRIC_BUCKETS = (0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 1.5, 2.5, 4, 8, 15, 30, 60, 90)


class JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "event": record.getMessage(),
        }
        data.update({field: getattr(record, field) for field in FIELDS if hasattr(record, field)})
        if request_id := request_context.get():
            data["request_id"] = request_id
        span = trace.get_current_span().get_span_context()
        if span.is_valid:
            data["trace_id"] = f"{span.trace_id:032x}"
        return json.dumps(data, separators=(",", ":"))


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JSONFormatter())
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for name in ("httpx", "httpcore", "uvicorn.access"):
        logging.getLogger(name).setLevel(logging.WARNING)
    # Export failures on the standard SDK loggers can include transport URLs.
    logging.getLogger("opentelemetry.exporter").setLevel(logging.CRITICAL)


class Telemetry:
    def __init__(self, settings: RuntimeSettings) -> None:
        self.provider = TracerProvider(
            resource=Resource.create(
                {"service.name": "aegis-ai-gateway", "deployment.environment.name": settings.environment}
            ),
            sampler=ParentBased(TraceIdRatioBased(settings.trace_sample_rate)),
        )
        if settings.trace_endpoint:
            self.provider.add_span_processor(
                BatchSpanProcessor(
                    OTLPSpanExporter(endpoint=settings.trace_endpoint, timeout=2),
                    max_queue_size=1024,
                    max_export_batch_size=128,
                    schedule_delay_millis=2000,
                )
            )
        self.tracer = self.provider.get_tracer("aegis")
        registry = self.registry = CollectorRegistry()
        self.requests = Counter(
            "aegis_http_requests_total", "HTTP requests", ["route", "status"], registry=registry
        )
        self.attempts = Counter(
            "aegis_provider_attempts_total", "Provider attempts", ["provider", "outcome"], registry=registry
        )
        self.streams = Gauge("aegis_stream_active", "Committed SSE streams", registry=registry)
        self.admission = Histogram(
            "aegis_gateway_admission_seconds",
            "Time to first authorization",
            ["mode"],
            buckets=METRIC_BUCKETS,
            registry=registry,
        )
        self.routing = Histogram(
            "aegis_routing_evaluation_seconds",
            "Deterministic routing evaluation, excluding database and Redis reads",
            ["mode"],
            buckets=(0.00001, 0.000025, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.005, 0.025),
            registry=registry,
        )
        self.first = Histogram(
            "aegis_stream_first_semantic_seconds",
            "Time to first semantic upstream event",
            ["provider"],
            buckets=METRIC_BUCKETS,
            registry=registry,
        )
        self.completion = Histogram(
            "aegis_completion_seconds",
            "Total chat execution time",
            ["mode", "outcome"],
            buckets=METRIC_BUCKETS,
            registry=registry,
        )
        self.provider_latency = Histogram(
            "aegis_provider_seconds",
            "Provider operation time",
            ["provider", "mode"],
            buckets=METRIC_BUCKETS,
            registry=registry,
        )
        self.fallbacks = Counter("aegis_fallbacks_total", "Dispatched fallback attempts", registry=registry)
        self.denials = Counter(
            "aegis_admission_denials_total", "Rejected admissions", ["code"], registry=registry
        )
        self.reconcile_overages = Counter(
            "aegis_ledger_overage_total",
            "Observed charges beyond a certified hold",
            ["provider"],
            registry=registry,
        )
        self.breaker = Gauge(
            "aegis_circuit_state",
            "Last observed breaker states on this replica",
            ["provider", "state"],
            registry=registry,
        )
        self.model_selections = Counter(
            "aegis_model_selections_total",
            "Selections by bounded deployment class",
            ["provider", "quality"],
            registry=registry,
        )
        self._breaker_states: dict[tuple, str] = {}

    def record_breaker(self, key: tuple, state: str) -> None:
        if state not in {"closed", "open", "half_open", "probe_ready", "unknown", "cooldown"}:
            return
        previous = self._breaker_states.get(key)
        if previous == state:
            return
        if previous:
            self.breaker.labels(key[0], previous).dec()
        if len(self._breaker_states) >= 2048 and not previous:
            evicted_key, evicted = self._breaker_states.popitem()
            self.breaker.labels(evicted_key[0], evicted).dec()
        self._breaker_states[key] = state
        self.breaker.labels(key[0], state).inc()

    def span(self, name: str, *, kind: SpanKind = SpanKind.INTERNAL, **attributes):
        return self.tracer.start_as_current_span(
            name,
            kind=kind,
            attributes=attributes,
            record_exception=False,
            set_status_on_exception=False,
        )
