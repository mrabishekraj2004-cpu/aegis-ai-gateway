from dataclasses import dataclass
from uuid import UUID

from aegis.contracts import TokenUsage


class GatewayError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        param: str | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(code)
        self.status, self.code, self.message = status, code, message
        self.param, self.retry_after = param, retry_after

    def body(self, request_id: UUID) -> dict:
        types = {
            401: "authentication_error",
            403: "permission_error",
            409: "conflict_error",
            429: "rate_limit_error",
            500: "server_error",
            502: "upstream_error",
            503: "service_unavailable_error",
            504: "timeout_error",
        }
        return {
            "error": {
                "message": self.message,
                "type": types.get(self.status, "invalid_request_error"),
                "param": self.param,
                "code": self.code,
            },
            "request_id": str(request_id),
        }

    def headers(self) -> dict[str, str]:
        headers = {"Cache-Control": "no-store"}
        if self.status == 401:
            headers["WWW-Authenticate"] = "Bearer"
        if self.retry_after is not None:
            headers["Retry-After"] = str(self.retry_after)
        return headers


@dataclass
class ProviderFailure(Exception):
    code: str
    status: int = 502
    retryable: bool = True
    unsent: bool = False
    breaker_failure: bool | None = True
    cooldown: int = 0
    quarantine: bool = False
    usage: TokenUsage | None = None

    def __post_init__(self) -> None:
        super().__init__(self.code)

    def gateway_error(self) -> GatewayError:
        messages = {
            "provider_timeout": "The upstream provider timed out.",
            "provider_overloaded": "The upstream provider is temporarily unavailable.",
            "content_rejected": "The upstream provider rejected the request.",
            "provider_protocol_error": "The upstream provider returned an invalid response.",
        }
        return GatewayError(
            self.status,
            self.code,
            messages.get(self.code, "The upstream request failed."),
            retry_after=self.cooldown or None,
        )
