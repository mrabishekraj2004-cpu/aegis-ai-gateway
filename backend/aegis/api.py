import asyncio
import hmac
import json
import re
from collections.abc import Mapping
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from time import monotonic
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.openapi.utils import get_openapi
from opentelemetry.trace import SpanKind, StatusCode
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from aegis.accounting import Accounting
from aegis.auth import Auth, require
from aegis.catalog import Catalog
from aegis.contracts import (
    ActivePolicyChange,
    Chat,
    ChatCompletion,
    DisabledPolicyChange,
    Health,
    ModelList,
    RequestInfo,
)
from aegis.database import Database
from aegis.errors import GatewayError
from aegis.gateway import ChatResponse, Gateway
from aegis.providers.anthropic import Anthropic
from aegis.providers.base import Provider
from aegis.providers.mock import Mock
from aegis.providers.openai import OpenAI
from aegis.queries import Cursors, UsagePage, day_range, usage_report
from aegis.reliability import Controls
from aegis.settings import Settings
from aegis.telemetry import Telemetry, configure_logging, logger, request_context

CORRELATION = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
MAX_BODY = 128 * 1024
MAX_BODY_READ_TIME = 2
KNOWN_PATHS = {
    "/v1/chat/completions",
    "/v1/models",
    "/v1/usage",
    "/v1/health",
    "/livez",
    "/v1/metrics",
    "/v1/admin/routing-policies",
    "/docs",
    "/openapi.json",
}


class CorrelationMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        now, request_id = monotonic(), uuid4()
        state = scope.setdefault("state", {})
        state["request_id"], state["started"], state["received_at"] = request_id, now, datetime.now(UTC)
        telemetry: Telemetry = scope["app"].state.telemetry
        route = scope["path"] if scope["path"] in KNOWN_PATHS else "other"
        token = request_context.set(str(request_id))
        status = 0

        async def send_headers(message: dict) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message.setdefault("headers", []).append((b"x-request-id", str(request_id).encode()))
            await send(message)

        try:
            with telemetry.span(
                "aegis.http", kind=SpanKind.SERVER, route=route, **{"aegis.request_id": str(request_id)}
            ) as span:
                try:
                    await self.app(scope, receive, send_headers)
                except Exception:  # noqa: BLE001 - sanitize unhandled ASGI application errors
                    if status:
                        # Error after commitment must not trigger a second HTTP response.
                        logger.error("response_aborted")
                    else:
                        logger.error("http_internal_error")
                        error = GatewayError(500, "internal_error", "An internal gateway error occurred.")
                        await error_response(error, request_id)(scope, receive, send_headers)
                finally:
                    span.set_attribute("http.response.status_code", status)
                    if status >= 500:
                        span.set_status(StatusCode.ERROR)
                    telemetry.requests.labels(route, str(status or 499)).inc()
                    logger.info(
                        "http_request",
                        extra={
                            "route": route,
                            "status": status or 499,
                            "duration_ms": int((monotonic() - now) * 1000),
                        },
                    )
        finally:
            request_context.reset(token)


def error_response(error: GatewayError, request_id: UUID) -> JSONResponse:
    return JSONResponse(error.body(request_id), error.status, headers=error.headers())


def invalid_input(error: ValidationError) -> GatewayError:
    errors = sorted(
        error.errors(include_url=False, include_input=False, include_context=False),
        key=lambda item: tuple(str(part) for part in item["loc"]),
    )
    first = errors[0]
    fields = {
        "model",
        "messages",
        "role",
        "content",
        "stream",
        "max_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "stop",
        "n",
        "stream_options",
        "include_usage",
        "aegis",
        "latency_class",
        *ActivePolicyChange.model_fields,
        "deployment_id",
        "priority",
        "weight",
        "source",
        "target",
    }
    # Validation paths can contain attacker input. Only serialize documented names and bounded indexes.
    parts = [
        str(part)
        for part in first["loc"]
        if (type(part) is int and 0 <= part <= 100) or (isinstance(part, str) and part in fields)
    ]
    return GatewayError(
        400,
        "unsupported_parameter" if first["type"] == "extra_forbidden" else "invalid_request",
        "The request does not match the supported schema.",
        param=".".join(parts) or None,
    )


def unique_pairs(items: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def unsupported_constant(_: str):
    raise ValueError("nonfinite JSON number")


async def read_json(request: Request) -> tuple[dict, bytes]:
    if (
        len(request.headers.getlist("content-type")) != 1
        or request.headers["content-type"].split(";", 1)[0].strip().lower() != "application/json"
        or request.headers.getlist("content-encoding")
    ):
        raise GatewayError(415, "unsupported_media_type", "Use unencoded UTF-8 application/json.")
    lengths = request.headers.getlist("content-length")
    if lengths:
        if len(lengths) != 1 or not (lengths[0].isascii() and lengths[0].isdigit()) or len(lengths[0]) > 16:
            raise GatewayError(400, "invalid_request", "Invalid content length.")
        if int(lengths[0]) > MAX_BODY:
            raise GatewayError(413, "request_too_large", "The request exceeds the body size limit.")
    payload = bytearray()
    try:
        async with asyncio.timeout(MAX_BODY_READ_TIME):
            async for chunk in request.stream():
                if len(payload) + len(chunk) > MAX_BODY:
                    raise GatewayError(413, "request_too_large", "The request exceeds the body size limit.")
                payload.extend(chunk)
    except TimeoutError:
        raise GatewayError(504, "request_timeout", "The request body deadline expired.") from None
    except ClientDisconnect:
        raise GatewayError(400, "invalid_request", "The request body was interrupted.") from None
    try:
        raw = bytes(payload)
        data = json.loads(
            raw.decode("utf-8"), object_pairs_hook=unique_pairs, parse_constant=unsupported_constant
        )
        if not isinstance(data, dict):
            raise TypeError
    except (UnicodeError, ValueError, TypeError, RecursionError):
        raise GatewayError(400, "invalid_request", "The request body must be a UTF-8 JSON object.") from None
    return data, raw


def query(request: Request, allowed: set[str]) -> dict[str, str]:
    result = {}
    for key, value in request.query_params.multi_items():
        if key not in allowed or key in result or len(value) > 2048:
            raise GatewayError(400, "invalid_request", "Invalid query parameter.")
        result[key] = value
    return result


def page_limit(values: Mapping[str, str]) -> int:
    limit = values.get("limit", "50")
    if not re.fullmatch(r"[1-9][0-9]{0,2}", limit) or int(limit) > 100:
        raise GatewayError(400, "invalid_request", "Page limit must be between 1 and 100.", param="limit")
    return int(limit)


async def authenticate(request: Request, scope: str, *, users_only: bool = False):
    state = request.app.state
    with state.telemetry.span("aegis.auth"):
        actor = await state.auth.principal(request.headers, users_only=users_only)
        require(actor, scope)
    return actor


def body_schema(*names: str) -> dict:
    refs = [{"$ref": f"#/components/schemas/{name}"} for name in names]
    schema = refs[0] if len(refs) == 1 else {"oneOf": refs}
    return {"requestBody": {"required": True, "content": {"application/json": {"schema": schema}}}}


def create_app(
    settings: Settings | None = None, *, provider_overrides: dict[str, Provider] | None = None
) -> FastAPI:
    settings = settings or Settings()
    if provider_overrides and settings.environment != "test":
        raise ValueError("Provider overrides are test-only.")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging()
        telemetry = app.state.telemetry = Telemetry(settings)
        credentials = {
            name: value.get_secret_value() for name, value in settings.provider_credentials.items()
        }
        async with AsyncExitStack() as stack:
            stack.callback(telemetry.provider.shutdown)
            database = app.state.db = Database(settings)
            stack.push_async_callback(database.close)
            await database.verify()
            controls = Controls(settings)
            stack.push_async_callback(controls.close)
            timeout = httpx.Timeout(20, connect=2, write=2, pool=0.1)
            limits = httpx.Limits(max_connections=settings.deployment_inflight, max_keepalive_connections=20)
            clients = [
                await stack.enter_async_context(
                    httpx.AsyncClient(timeout=timeout, limits=limits, trust_env=False, follow_redirects=False)
                )
                for _ in range(3)
            ]
            providers = {
                "mock": Mock(),
                "openai": OpenAI(clients[0], "https://api.openai.com/v1/chat/completions", credentials),
                "anthropic": Anthropic(clients[1], "https://api.anthropic.com/v1/messages", credentials),
                **(provider_overrides or {}),
            }
            app.state.auth = Auth(settings, database, clients[2])
            app.state.catalog = Catalog(database)
            app.state.gateway = Gateway(
                settings, app.state.catalog, Accounting(database), controls, providers, telemetry
            )
            app.state.cursors = Cursors(settings.cursor_secret.get_secret_value())
            try:
                yield
            finally:
                app.state.gateway.draining = True

    app = FastAPI(
        title="Aegis AI Gateway",
        version="0.1.0",
        lifespan=lifespan,
        redoc_url=None,
        docs_url="/docs" if settings.environment in {"local", "test"} else None,
    )
    if settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.allowed_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Tenant-ID", "X-Client-Request-ID"],
            expose_headers=["X-Request-ID", "Retry-After"],
        )
    app.add_middleware(CorrelationMiddleware)

    @app.exception_handler(GatewayError)
    async def gateway_error(request: Request, error: GatewayError):
        if error.status in (401, 403):
            logger.info("access_denied", extra={"code": error.code})
        return error_response(error, request.state.request_id)

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, error: SQLAlchemyError):
        logger.warning("database_unavailable")
        return error_response(
            GatewayError(503, "dependency_unavailable", "The database is unavailable."),
            request.state.request_id,
        )

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        code = "resource_not_found" if error.status_code == 404 else "invalid_request"
        return error_response(
            GatewayError(error.status_code, code, "The HTTP operation is unavailable."),
            request.state.request_id,
        )

    @app.post(
        "/v1/chat/completions",
        response_model=ChatCompletion,
        responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
        openapi_extra=body_schema("Chat"),
    )
    async def completions(request: Request):
        auth = request.app.state.auth
        with request.app.state.telemetry.span("aegis.auth"):
            actor = await auth.principal(request.headers)
            require(actor, "chat:write" if actor.kind == "key" else "playground:run")
        data, _ = await read_json(request)
        try:
            chat = Chat.model_validate(data)
        except ValidationError as exc:
            raise invalid_input(exc) from None
        correlators = request.headers.getlist("x-client-request-id")
        if len(correlators) > 1 or (correlators and not CORRELATION.fullmatch(correlators[0])):
            raise GatewayError(400, "invalid_request", "Invalid client request identifier.")
        duration = settings.stream_deadline if chat.stream else settings.json_deadline
        info = RequestInfo(
            request.state.request_id,
            request.state.received_at,
            request.state.started + duration,
            correlators[0] if correlators else None,
            started=request.state.started,
        )
        return ChatResponse(request.app.state.gateway, actor, chat, info)

    @app.get("/v1/models", response_model=ModelList)
    async def models(request: Request):
        actor = await authenticate(request, "models:read")
        query(request, set())
        entries = await request.app.state.catalog.list_models(actor.tenant_id)
        return JSONResponse(
            ModelList(data=entries).model_dump(mode="json"), headers={"Cache-Control": "no-store"}
        )

    @app.get("/v1/usage", response_model=UsagePage)
    async def usage(request: Request):
        actor = await authenticate(request, "usage:read")
        values = query(request, {"from", "to", "model", "group_by", "limit", "cursor"})
        now = datetime.now(UTC)
        start, end = day_range(values.get("from"), values.get("to"), now.date())
        group = values.get("group_by", "day")
        if group not in {"day", "model", "day_model"}:
            raise GatewayError(400, "invalid_request", "Unsupported usage grouping.", param="group_by")
        model, limit = values.get("model"), page_limit(values)
        filters = {"from": str(start), "to": str(end), "model": model, "group_by": group}
        cursors, position, snapshot = request.app.state.cursors, None, now
        if "cursor" in values:
            snapshot, last = cursors.read(values["cursor"], actor.tenant_id, "usage", filters)
            position = date.fromisoformat(last[0]) if last[0] else None, last[1] or None
        rows = await usage_report(
            request.app.state.db, actor.tenant_id, start, end, model, group, limit, snapshot, position
        )
        tail = rows[limit - 1] if len(rows) > limit else None
        cursor = (
            cursors.issue(
                actor.tenant_id, "usage", filters, snapshot, [str(tail["day"] or ""), tail["model"] or ""]
            )
            if tail
            else None
        )
        complete = min(end - timedelta(days=1), now.date() - timedelta(days=1))
        page = UsagePage(
            data=rows[:limit],
            as_of=now,
            complete_through=complete if complete >= start else None,
            range={"from": start, "to": end},
            has_more=tail is not None,
            next_cursor=cursor,
        )
        return JSONResponse(page.model_dump(mode="json"), headers={"Cache-Control": "no-store"})

    @app.get("/v1/admin/routing-policies")
    async def get_policies(request: Request):
        actor = await authenticate(request, "policies:read", users_only=True)
        values = query(request, {"model", "status", "limit", "cursor"})
        model, status, limit = values.get("model"), values.get("status"), page_limit(values)
        if status not in {None, "active", "disabled"}:
            raise GatewayError(400, "invalid_request", "Invalid policy status.")
        snapshot, position = datetime.now(UTC), None
        filters = {"model": model, "status": status}
        cursors = request.app.state.cursors
        if "cursor" in values:
            snapshot, tail = cursors.read(values["cursor"], actor.tenant_id, "policies", filters)
            position = datetime.fromisoformat(tail[0]), UUID(tail[1])
        rows = await request.app.state.catalog.list_policies(
            actor.tenant_id, model, status, limit, snapshot, position
        )
        more = len(rows) > limit
        cursor = (
            cursors.issue(
                actor.tenant_id,
                "policies",
                filters,
                snapshot,
                [rows[limit - 1]["updated_at"].isoformat(), str(rows[limit - 1]["id"])],
            )
            if more
            else None
        )
        return JSONResponse(
            jsonable_encoder(
                {"object": "list", "data": rows[:limit], "has_more": more, "next_cursor": cursor}
            ),
            headers={"Cache-Control": "no-store"},
        )

    @app.post(
        "/v1/admin/routing-policies",
        status_code=201,
        openapi_extra=body_schema("ActivePolicyChange", "DisabledPolicyChange"),
    )
    async def change_policy(request: Request):
        actor = await authenticate(request, "policies:write", users_only=True)
        data, raw = await read_json(request)
        schema = DisabledPolicyChange if data.get("status") == "disabled" else ActivePolicyChange
        try:
            change = schema.model_validate_json(raw)
        except ValidationError as exc:
            raise invalid_input(exc) from None
        version = await request.app.state.catalog.publish(actor, change, request.state.request_id)
        return JSONResponse(jsonable_encoder(version), 201, headers={"Cache-Control": "no-store"})

    @app.get("/v1/health", response_model=Health, responses={503: {"model": Health}})
    async def ready(request: Request):
        query(request, set())
        gateway = request.app.state.gateway
        try:
            async with asyncio.timeout(0.4):
                await request.app.state.db.verify()
                available = not gateway.draining and await gateway.controls.ready()
        except (RuntimeError, SQLAlchemyError, TimeoutError):
            available = False
        result = Health(status="ok" if available else "unavailable", request_id=request.state.request_id)
        return JSONResponse(
            result.model_dump(mode="json"), 200 if available else 503, headers={"Cache-Control": "no-store"}
        )

    @app.get("/livez", include_in_schema=False)
    async def live():
        return Response("ok\n", media_type="text/plain")

    @app.get("/v1/metrics", responses={200: {"content": {"text/plain": {}}}}, response_class=Response)
    async def metrics(request: Request):
        if settings.metrics_token is None:
            raise GatewayError(404, "resource_not_found", "The requested resource is unavailable.")
        tokens = request.headers.getlist("authorization")
        expected = f"Bearer {settings.metrics_token.get_secret_value()}".encode()
        if len(tokens) != 1 or not hmac.compare_digest(tokens[0].encode(), expected):
            raise GatewayError(401, "authentication_required", "Collector authentication is required.")
        query(request, set())
        return Response(
            generate_latest(request.app.state.telemetry.registry),
            headers={"Content-Type": CONTENT_TYPE_LATEST, "Cache-Control": "no-store"},
        )

    def openapi() -> dict:
        if not app.openapi_schema:
            schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
            components = schema.setdefault("components", {})
            schemas = components.setdefault("schemas", {})
            for model in (Chat, ActivePolicyChange, DisabledPolicyChange):
                shaped = model.model_json_schema(ref_template="#/components/schemas/{model}")
                schemas.update(shaped.pop("$defs", {}))
                schemas[model.__name__] = shaped
            components["securitySchemes"] = {"bearer": {"type": "http", "scheme": "bearer"}}
            for route, path in schema["paths"].items():
                if route != "/v1/health":
                    for operation in path.values():
                        operation["security"] = [{"bearer": []}]
            app.openapi_schema = schema
        return app.openapi_schema

    app.openapi = openapi
    return app
