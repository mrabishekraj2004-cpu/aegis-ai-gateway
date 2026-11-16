import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Protocol

import httpx

from aegis.contracts import Chat, Deployment, ProviderEvent, ProviderResult
from aegis.errors import ProviderFailure

MAX_EVENT = 256 * 1024
MAX_JSON = 1024 * 1024


class Provider(Protocol):
    async def complete(self, deployment: Deployment, chat: Chat) -> ProviderResult: ...

    def stream(self, deployment: Deployment, chat: Chat) -> AsyncIterator[ProviderEvent]: ...


def protocol_failure() -> ProviderFailure:
    return ProviderFailure("provider_protocol_error")


def object_payload(raw: bytes) -> dict:
    try:
        result = json.loads(raw)
    except (ValueError, RecursionError):
        raise protocol_failure() from None
    if not isinstance(result, dict):
        raise protocol_failure()
    return result


def retry_after(value: str | None) -> int:
    if value:
        try:
            seconds = (
                int(value)
                if value.isascii() and value.isdigit()
                else int((parsedate_to_datetime(value).astimezone(UTC) - datetime.now(UTC)).total_seconds())
            )
            return min(60, max(1, seconds))
        except (ValueError, TypeError, OverflowError):
            pass
    return 1


class HTTPProvider:
    def __init__(self, client: httpx.AsyncClient, endpoint: str, credentials: dict[str, str]) -> None:
        self.client = client
        self.endpoint = endpoint
        self.credentials = credentials

    def auth_headers(self, credential: str) -> dict[str, str]:
        raise NotImplementedError

    @asynccontextmanager
    async def response(
        self, deployment: Deployment, payload: dict, *, stream: bool
    ) -> AsyncIterator[httpx.Response]:
        credential = self.credentials.get(deployment.credential_ref or "")
        if not credential:
            raise ProviderFailure("provider_error", unsent=True, breaker_failure=None, retryable=False)
        headers = self.auth_headers(credential)
        headers["accept-encoding"] = "identity"
        headers["accept"] = "text/event-stream" if stream else "application/json"
        try:
            async with self.client.stream("POST", self.endpoint, json=payload, headers=headers) as response:
                status = response.status_code
                if status == 429:
                    raise ProviderFailure(
                        "provider_overloaded", 503, cooldown=retry_after(response.headers.get("retry-after"))
                    )
                if status in (401, 403, 404):
                    raise ProviderFailure("provider_error", quarantine=True)
                if status == 408:
                    raise ProviderFailure("provider_timeout", 504)
                if status >= 500:
                    raise ProviderFailure("provider_error")
                if 400 <= status < 500:
                    raise ProviderFailure("content_rejected", 400, retryable=False, breaker_failure=None)
                content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                if status != 200 or content_type != headers["accept"]:
                    raise protocol_failure()
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    raise protocol_failure()
                yield response
        except httpx.PoolTimeout:
            raise ProviderFailure("gateway_overloaded", 503, unsent=True, breaker_failure=None) from None
        except (httpx.ConnectTimeout, httpx.ConnectError) as exc:
            raise ProviderFailure(
                "provider_timeout" if isinstance(exc, httpx.ConnectTimeout) else "provider_error",
                504 if isinstance(exc, httpx.ConnectTimeout) else 502,
                unsent=True,
            ) from None
        except httpx.TimeoutException:
            raise ProviderFailure("provider_timeout", 504) from None
        except httpx.HTTPError:
            raise ProviderFailure("provider_protocol_error") from None


async def read_json(response: httpx.Response) -> dict:
    payload = bytearray()
    async for chunk in response.aiter_bytes():
        if len(payload) + len(chunk) > MAX_JSON:
            raise protocol_failure()
        payload.extend(chunk)
    return object_payload(payload)


async def events(response: httpx.Response) -> AsyncIterator[tuple[str | None, bytes]]:
    """Parse a bounded SSE byte stream without relying on transport chunk boundaries."""
    line = bytearray()
    data: list[bytes] = []
    event = None
    size = 0
    async for chunk in response.aiter_bytes():
        parts = chunk.split(b"\n")
        for i, part in enumerate(parts):
            if len(line) + len(part) > MAX_EVENT:
                raise protocol_failure()
            line.extend(part)
            if i == len(parts) - 1:
                break
            current = bytes(line).removesuffix(b"\r")
            line.clear()
            if not current:
                if data:
                    yield event, b"\n".join(data)
                data.clear()
                size = 0
                event = None
                continue
            name, _, value = current.partition(b":")
            value = value.removeprefix(b" ")
            if name == b"data":
                size += len(value) + 1
                if size > MAX_EVENT:
                    raise protocol_failure()
                data.append(value)
            elif name == b"event":
                try:
                    event = value.decode("ascii")
                except UnicodeError:
                    raise protocol_failure() from None
    if line or data:
        raise protocol_failure()
