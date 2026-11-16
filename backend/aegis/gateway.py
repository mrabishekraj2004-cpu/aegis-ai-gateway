import asyncio
import json
import random
from collections.abc import AsyncIterator, Coroutine
from contextlib import suppress
from time import monotonic

from anyio import CancelScope, create_task_group
from opentelemetry.trace import SpanKind, StatusCode
from sqlalchemy.exc import SQLAlchemyError
from starlette.responses import JSONResponse, Response
from starlette.types import Receive, Scope, Send

from aegis.accounting import Accounting, Authorized, accounting_unavailable
from aegis.catalog import Catalog
from aegis.contracts import Chat, Policy, Principal, ProviderEvent, RequestInfo, TokenUsage
from aegis.errors import GatewayError, ProviderFailure
from aegis.providers.base import Provider, protocol_failure
from aegis.reliability import BreakerGrant, Controls, Lease, close_leases, redis_down
from aegis.routing import Candidate, empty_route_error, latency_class_for, routing_decision
from aegis.settings import Settings
from aegis.telemetry import Telemetry, logger

MARGIN = 0.5
MAX_OUTPUT = 128 * 1024


class Gateway:
    def __init__(
        self,
        settings: Settings,
        catalog: Catalog,
        accounting: Accounting,
        controls: Controls,
        providers: dict[str, Provider],
        telemetry: Telemetry,
    ) -> None:
        self.settings, self.catalog, self.accounting, self.controls = settings, catalog, accounting, controls
        self.providers, self.telemetry = providers, telemetry
        self.credentials = frozenset(settings.provider_credentials)
        self.inflight = 0
        self.draining = False


class ChatResponse(Response):
    def __init__(self, gateway: Gateway, actor: Principal, chat: Chat, info: RequestInfo) -> None:
        super().__init__()
        self.run = ChatExecution(gateway, actor, chat, info)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        run = self.run
        run.send = send
        async with create_task_group() as group:
            with CancelScope() as disconnected:

                async def watch() -> None:
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            if run.terminal_written:
                                return
                            run.disconnected = True
                            disconnected.cancel()
                            return

                group.start_soon(watch)
                try:
                    async with asyncio.timeout(run.remaining()):
                        await run.execute()
                except GatewayError as exc:
                    await run.reply_error(exc)
                except (SQLAlchemyError, OSError) as exc:
                    if isinstance(exc, OSError):
                        run.disconnected = True
                    else:
                        await run.reply_error(accounting_unavailable())
                except TimeoutError:
                    await run.reply_error(
                        GatewayError(504, "request_timeout", "The request deadline expired.")
                    )
                except Exception:  # noqa: BLE001 - return a sanitized error at the transport boundary
                    logger.error("chat_internal_error")
                    await run.reply_error(
                        GatewayError(500, "internal_error", "An internal gateway error occurred.")
                    )
                finally:
                    with CancelScope(shield=True):
                        await run.cleanup()
            group.cancel_scope.cancel()


class ChatExecution:
    def __init__(self, gateway: Gateway, actor: Principal, chat: Chat, info: RequestInfo) -> None:
        self.gateway, self.actor, self.chat, self.info = gateway, actor, chat, info
        self.settings, self.controls, self.accounting = gateway.settings, gateway.controls, gateway.accounting
        self.telemetry = gateway.telemetry
        self.admitted = self.committed = self.sse = self.delivered = self.disconnected = self.local = False
        self.tenant_lease: Lease | None = None
        self.active: Authorized | None = None
        self.active_lease: Lease | None = None
        self.usage: TokenUsage | None = None
        self.active_sent = False
        self.terminal_written = False
        self.output_size = 0
        self.heartbeat = 0.0
        self.failure_code: str | None = None
        self.send: Send
        self.ordinal = 0
        self.started = self.info.started if self.info.started is not None else monotonic()
        self.mode = "sse" if chat.stream else "json"
        self.latency_class = "standard"

    @property
    def tenant_scope(self) -> str:
        return f"t:{self.actor.tenant_id}"

    def remaining(self, *, margin: float = 0) -> float:
        return self.info.deadline - monotonic() - margin

    def identity(self, kind: str) -> dict:
        return {
            "id": f"chatcmpl-{self.info.request_id}",
            "object": kind,
            "model": self.chat.model,
            "created": int(self.info.received_at.timestamp()),
        }

    async def execute(self) -> None:
        if self.gateway.draining or self.gateway.inflight >= self.settings.process_inflight:
            raise GatewayError(503, "gateway_overloaded", "Gateway concurrency is exhausted.")
        self.gateway.inflight += 1
        self.local = True
        with self.telemetry.span("aegis.admission", mode=self.mode):
            self.tenant_lease = await self.controls.acquire(self.tenant_scope, self.settings.tenant_inflight)
            if self.tenant_lease is None:
                raise GatewayError(
                    429, "concurrency_limit_exceeded", "Tenant concurrency is exhausted.", retry_after=1
                )
            await self.controls.debit(self.actor, self.chat.prompt_quota)
            policy = await self.gateway.catalog.active(
                self.actor.tenant_id, self.chat.model, self.info.received_at
            )
            self.latency_class = latency_class_for(self.chat, policy)
            pairs = await asyncio.gather(
                *[self.controls.signal(item, self.chat, self.latency_class) for item in policy.deployments]
            )
            signals = dict(zip((item.id for item in policy.deployments), pairs, strict=True))
            with self.telemetry.span("aegis.route"), self.telemetry.routing.labels(self.mode).time():
                decision = routing_decision(
                    self.chat,
                    policy,
                    self.actor.tenant_id,
                    self.info.request_id,
                    self.latency_class,
                    signals,
                    self.gateway.credentials,
                )
            if not decision.ranked:
                raise empty_route_error(decision)
            await self.accounting.admit(self.actor, self.info, self.chat, policy, decision.evidence())
            self.admitted = True

        first = await self.dispatch(policy, decision.initial(), retry=False)
        if first is None:
            return
        candidate, failure, probe = first
        if self.committed or probe or self.settings.retry_limit < 2 or not failure.retryable:
            raise failure.gateway_error()
        if not failure.unsent and not policy.config.allow_ambiguous_failover:
            raise failure.gateway_error()
        source = candidate.deployment
        approved = {edge.target for edge in policy.config.fallback_edges if edge.source == source.id}
        alternatives = [
            item
            for item in decision.ranked
            if item.deployment.id in approved
            and (
                not (failure.cooldown or failure.quarantine)
                or (
                    item.deployment.quota_group != source.quota_group
                    and item.deployment.credential_ref != source.credential_ref
                )
            )
        ]
        if failure.unsent and failure.breaker_failure is True:
            alternatives.append(candidate)
        backoff = random.uniform(0, 0.1)
        if alternatives and self.remaining(margin=MARGIN) > backoff + 1:
            await asyncio.sleep(backoff)
            with self.telemetry.span("aegis.fallback", reason=failure.code):
                try:
                    second = await self.dispatch(policy, alternatives, retry=True)
                except GatewayError as exc:
                    if exc.code in {"no_healthy_route", "budget_exceeded", "request_cost_limit_exceeded"}:
                        raise failure.gateway_error() from None
                    raise
            if second is None:
                return
            raise second[1].gateway_error()
        raise failure.gateway_error()

    async def dispatch(
        self,
        policy: Policy,
        candidates: list[Candidate],
        *,
        retry: bool,
    ) -> tuple[Candidate, ProviderFailure, bool] | None:
        if not candidates:
            raise GatewayError(503, "no_healthy_route", "No eligible healthy deployment is available.")
        try:
            async with asyncio.timeout(0.15):
                phases = await asyncio.gather(
                    *[self.controls.probe_state(item.deployment) for item in candidates]
                )
        except TimeoutError:
            raise redis_down() from None
        for item, phase in zip(candidates, phases, strict=True):
            deployment = item.deployment
            self.telemetry.record_breaker(
                (deployment.provider, deployment.id, deployment.credential_revision), phase
            )
        eligible = [
            (item, phase)
            for item, phase in zip(candidates, phases, strict=True)
            if phase == "closed" or (phase == "probe_ready" and not retry)
        ]
        # Preserve routing order in each phase, and try ordinary traffic before a controlled probe.
        eligible.sort(key=lambda pair: pair[1] != "closed")
        denied: dict[str, GatewayError] = {}
        for candidate, _ in eligible:
            d = candidate.deployment
            if self.remaining(margin=MARGIN) <= 0 or not self.tenant_lease or not self.tenant_lease.valid():
                raise (
                    redis_down()
                    if self.remaining(margin=MARGIN) > 0
                    else GatewayError(504, "request_timeout", "The request deadline expired.")
                )
            lease = await self.controls.acquire(f"d:{d.id}", self.settings.deployment_inflight)
            if lease is None:
                continue
            self.active_lease = lease
            grant = None
            invoked = False
            try:
                grant = await self.controls.grant(d, self.remaining())
                if grant is None or (grant.probe and retry):
                    continue
                if retry and not await self.controls.retry_permitted(d):
                    continue
                with self.telemetry.span("aegis.reserve", provider=d.provider):
                    try:
                        self.active = await self.accounting.reserve(
                            self.actor, self.info, policy, candidate, self.ordinal + 1
                        )
                    except GatewayError as exc:
                        if exc.code in {"budget_exceeded", "request_cost_limit_exceeded", "no_healthy_route"}:
                            denied[exc.code] = exc
                            continue
                        raise
                self.ordinal += 1
                if self.ordinal == 1:
                    self.telemetry.admission.labels(self.mode).observe(monotonic() - self.started)
                else:
                    self.telemetry.fallbacks.inc()
                self.telemetry.model_selections.labels(d.provider, str(d.quality)).inc()
                invoked = True
                return await self.invoke(candidate, grant)
            finally:
                with CancelScope(shield=True):
                    if grant and not invoked:
                        await self.feedback(candidate, grant, None, duration_ms=0)
                    await close_leases(lease)
                self.active_lease = None
        for code in ("budget_exceeded", "request_cost_limit_exceeded", "no_healthy_route"):
            if code in denied:
                raise denied[code]
        raise GatewayError(503, "no_healthy_route", "No eligible healthy deployment is available.")

    async def invoke(
        self, candidate: Candidate, grant: BreakerGrant
    ) -> tuple[Candidate, ProviderFailure, bool] | None:
        provider_name = candidate.deployment.provider
        provider = self.gateway.providers[provider_name]
        started = monotonic()
        self.active_sent, self.usage = False, None
        self.output_size = 0
        try:
            await self.ensure_lease()
            with self.telemetry.span(
                "aegis.provider_attempt", kind=SpanKind.CLIENT, provider=provider_name, mode=self.mode
            ) as span:
                self.active_sent = True
                try:
                    if self.chat.stream:
                        await self.run_stream(provider, candidate)
                    else:
                        result = await self.wait(
                            provider.complete(candidate.deployment, self.chat),
                            self.settings.json_upstream_deadline,
                        )
                        self.usage = result.usage
                        if result.text is not None:
                            self.add_size(result.text)
                        await self.settle(success=True, reason=result.finish)
                        response = {
                            **self.identity("chat.completion"),
                            "choices": [
                                {
                                    "index": 0,
                                    "message": {"role": "assistant", "content": result.text},
                                    "finish_reason": result.finish,
                                    "logprobs": None,
                                }
                            ],
                            "usage": result.usage.public() if result.usage else None,
                        }
                        await self.send_json(response, 200)
                except ProviderFailure as exc:
                    span.set_status(StatusCode.ERROR, exc.code)
                    if exc.usage:
                        self.usage = exc.usage
                    await self.settle(success=False, reason=exc.code, unsent=exc.unsent)
                    await self.feedback(
                        candidate,
                        grant,
                        exc.breaker_failure,
                        duration_ms=int(1000 * (monotonic() - started)),
                        cooldown=exc.cooldown,
                        quarantine=exc.quarantine,
                    )
                    return candidate, exc, grant.probe
                await self.feedback(candidate, grant, False, duration_ms=int(1000 * (monotonic() - started)))
                return None
        except BaseException:
            with CancelScope(shield=True):
                await self.feedback(candidate, grant, None, duration_ms=0)
            raise
        finally:
            self.telemetry.provider_latency.labels(provider_name, self.mode).observe(monotonic() - started)

    async def feedback(
        self,
        candidate: Candidate,
        grant: BreakerGrant,
        failure: bool | None,
        *,
        duration_ms: int,
        cooldown: int = 0,
        quarantine: bool = False,
    ) -> None:
        d = candidate.deployment
        if failure is not None:
            self.telemetry.attempts.labels(d.provider, "failure" if failure else "success").inc()
        elif self.active is not None:
            self.telemetry.attempts.labels(d.provider, "interrupted").inc()
        with suppress(GatewayError):
            phase = await self.controls.feedback(d, grant, failure, cooldown=60 if quarantine else cooldown)
            self.telemetry.record_breaker((d.provider, d.id, d.credential_revision), phase)
            if failure is not None:
                observed = getattr(self, "ttft_ms", duration_ms)
                await self.controls.observe(d, self.chat, self.latency_class, failure, observed)

    async def ensure_lease(self) -> None:
        if (
            not self.tenant_lease
            or not self.active_lease
            or not self.tenant_lease.valid()
            or not self.active_lease.valid()
        ):
            raise redis_down()
        if self.remaining(margin=MARGIN) <= 0:
            raise GatewayError(504, "request_timeout", "The request deadline expired.")

    def add_size(self, text: str) -> None:
        try:
            self.output_size += len(text.encode("utf-8"))
        except UnicodeError:
            raise protocol_failure() from None
        if self.output_size > MAX_OUTPUT:
            raise protocol_failure()

    async def wait(self, coroutine: Coroutine, phase_limit: float, *, heartbeat: bool = False):
        ends = monotonic() + min(phase_limit, self.remaining(margin=MARGIN))
        task = asyncio.create_task(coroutine)
        try:
            leases = [lease for lease in (self.tenant_lease, self.active_lease) if lease]
            while True:
                await self.ensure_lease()
                now = monotonic()
                delay = min(ends - now, self.heartbeat - now) if heartbeat else ends - now
                if now >= ends:
                    raise ProviderFailure("provider_timeout", 504)
                done, _ = await asyncio.wait(
                    [task, *(lease.lost for lease in leases)],
                    timeout=max(0, delay),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if any(not lease.valid() for lease in leases):
                    raise redis_down()
                if task in done:
                    return task.result()
                if heartbeat and self.heartbeat <= monotonic() < ends:
                    await self.write(b": keepalive\n\n")
                    self.heartbeat = monotonic() + 10
        finally:
            if not task.done():
                task.cancel()
            with CancelScope(shield=True):
                await asyncio.gather(task, return_exceptions=True)

    async def semantic_event(self, stream: AsyncIterator[ProviderEvent]) -> ProviderEvent:
        async for event in stream:
            if event.usage is not None:
                self.usage = event.usage
            if event.text:
                self.add_size(event.text)
                return event
            if event.finish is not None:
                return event
        raise protocol_failure()

    async def run_stream(self, provider: Provider, candidate: Candidate) -> None:
        stream = provider.stream(candidate.deployment, self.chat)
        dispatch_time = monotonic()
        try:
            event = await self.wait(self.semantic_event(stream), self.settings.stream_first_deadline)
            self.ttft_ms = int(1000 * (monotonic() - dispatch_time))
            self.telemetry.first.labels(candidate.deployment.provider).observe(monotonic() - self.started)
            if event.finish is not None:
                await self.settle(success=True, reason=event.finish)
            await self.start_stream()
            await self.chunk(delta={"role": "assistant"})
            while event.finish is None:
                for index in range(0, len(event.text or ""), 4096):
                    await self.chunk(delta={"content": event.text[index : index + 4096]})
                event = await self.wait(
                    self.semantic_event(stream), self.settings.stream_idle_deadline, heartbeat=True
                )
                if event.finish is not None:
                    await self.settle(success=True, reason=event.finish)
            await self.chunk(delta={}, finish=event.finish)
            if self.chat.stream_options and self.chat.stream_options.include_usage:
                await self.chunk(delta={}, summary=True)
            await self.write(b"data: [DONE]\n\n")
            await self.write(b"", more=False)
            self.terminal_written = self.delivered = True
        finally:
            with CancelScope(shield=True), suppress(Exception):
                close = getattr(stream, "aclose", None)
                if close:
                    async with asyncio.timeout(0.25):
                        await close()

    async def start_stream(self) -> None:
        self.committed = self.sse = True
        self.telemetry.streams.inc()
        self.heartbeat = monotonic() + 10
        await self.write_message(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"text/event-stream; charset=utf-8"),
                    (b"cache-control", b"no-store, no-transform"),
                    (b"x-accel-buffering", b"no"),
                ],
            }
        )

    async def chunk(self, *, delta: dict, finish: str | None = None, summary: bool = False) -> None:
        item = self.identity("chat.completion.chunk")
        item["choices"] = (
            [] if summary else [{"index": 0, "delta": delta, "finish_reason": finish, "logprobs": None}]
        )
        if self.chat.stream_options and self.chat.stream_options.include_usage:
            item["usage"] = self.usage.public() if summary and self.usage else None
        await self.write(
            b"data: " + json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode() + b"\n\n"
        )

    async def write_message(self, message: dict, *, terminal_error: bool = False) -> None:
        remaining = self.remaining()
        if terminal_error:
            remaining = min(remaining if remaining > 0 else 0.15, 0.25)
        try:
            async with asyncio.timeout(max(0.001, min(5, remaining))):
                await self.send(message)
        except (OSError, TimeoutError):
            self.disconnected = True
            raise OSError("response transport closed") from None

    async def write(self, body: bytes, *, more: bool = True, terminal_error: bool = False) -> None:
        if len(body) > 32 * 1024:
            raise protocol_failure()
        await self.write_message(
            {"type": "http.response.body", "body": body, "more_body": more}, terminal_error=terminal_error
        )

    async def send_json(self, body: dict, status: int, headers: dict | None = None) -> None:
        response = JSONResponse(body, status, headers=headers or {"Cache-Control": "no-store"})
        self.committed = True
        await self.write_message(
            {"type": "http.response.start", "status": status, "headers": response.raw_headers},
            terminal_error=status >= 400,
        )
        await self.write_message(
            {"type": "http.response.body", "body": response.body, "more_body": False},
            terminal_error=status >= 400,
        )
        self.terminal_written = True
        self.delivered = status < 400

    async def settle(self, *, success: bool, reason: str, unsent: bool = False) -> None:
        attempt, self.active = self.active, None
        if attempt is None:
            raise accounting_unavailable()
        with self.telemetry.span("aegis.settle") as span:
            try:
                overage = await self.accounting.outcome(
                    attempt,
                    success=success,
                    reason=reason,
                    usage=self.usage,
                    unsent=unsent,
                )
            except SQLAlchemyError:
                span.set_status(StatusCode.ERROR, "accounting_unavailable")
                raise accounting_unavailable() from None
            if overage:
                self.telemetry.reconcile_overages.labels(attempt.candidate.deployment.provider).inc()
                logger.error(
                    "provider_billing_bound_exceeded",
                    extra={"provider": attempt.candidate.deployment.provider},
                )

    async def reply_error(self, error: GatewayError) -> None:
        self.failure_code = error.code
        self.telemetry.denials.labels(error.code).inc()
        body = error.body(self.info.request_id)
        if self.disconnected or self.terminal_written:
            return
        with suppress(OSError):
            if not self.committed:
                await self.send_json(body, error.status, error.headers())
            elif self.sse:
                payload = b"event: error\ndata: " + json.dumps(body, separators=(",", ":")).encode() + b"\n\n"
                await self.write(payload, more=False, terminal_error=True)
                self.terminal_written = True

    async def cleanup(self) -> None:
        if self.sse:
            self.telemetry.streams.dec()
        if self.local:
            self.gateway.inflight -= 1
        await close_leases(self.active_lease, self.tenant_lease)
        with suppress(GatewayError, SQLAlchemyError, TimeoutError):
            async with asyncio.timeout(0.5):
                if self.active is not None:
                    await self.settle(
                        success=False,
                        reason=self.failure_code or "client_disconnected",
                        unsent=not self.active_sent,
                    )
                if self.admitted:
                    reason = (
                        "client_disconnected" if self.disconnected else self.failure_code or "request_failed"
                    )
                    await self.accounting.mark_request(
                        self.actor.tenant_id,
                        self.info.request_id,
                        reason=reason,
                        state=None if self.delivered else "cancelled" if self.disconnected else "failed",
                        delivery="complete"
                        if self.delivered
                        else "disconnected"
                        if self.disconnected
                        else "partial"
                        if self.sse
                        else None,
                    )
        self.telemetry.completion.labels(
            self.mode, "success" if self.delivered else "disconnected" if self.disconnected else "failure"
        ).observe(monotonic() - self.started)
