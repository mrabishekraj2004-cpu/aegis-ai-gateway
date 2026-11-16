from collections.abc import AsyncIterator
from dataclasses import replace

from pydantic import ValidationError

from aegis.contracts import Chat, Deployment, Finish, ProviderEvent, ProviderResult, TokenUsage
from aegis.errors import ProviderFailure
from aegis.providers.base import HTTPProvider, events, object_payload, protocol_failure, read_json


def finish_reason(value: object) -> Finish:
    match value:
        case "stop" | "length" | "content_filter":
            return value
        case _:
            raise protocol_failure()


def extract_usage(value: object) -> TokenUsage | None:
    if value is None:
        return None
    try:
        usage = TokenUsage(
            prompt_tokens=value["prompt_tokens"],
            completion_tokens=value["completion_tokens"],
            cache_read=(value.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
        )
        if "total_tokens" in value and value["total_tokens"] != usage.prompt_tokens + usage.completion_tokens:
            raise ValueError
        return usage
    except (AttributeError, KeyError, TypeError, ValueError, ValidationError):
        raise protocol_failure() from None


class OpenAI(HTTPProvider):
    def auth_headers(self, credential: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {credential}"}

    @staticmethod
    def payload(deployment: Deployment, chat: Chat) -> dict:
        result = {
            "model": deployment.upstream_model,
            "messages": [message.model_dump() for message in chat.messages],
            "stream": chat.stream,
            "max_completion_tokens": chat.output_ceiling,
            "n": 1,
        }
        for key in ("temperature", "top_p", "stop"):
            if (value := getattr(chat, key)) is not None:
                result[key] = value
        if chat.stream:
            result["stream_options"] = {"include_usage": True}
        return result

    async def complete(self, deployment: Deployment, chat: Chat) -> ProviderResult:
        async with self.response(deployment, self.payload(deployment, chat), stream=False) as response:
            payload = await read_json(response)
        usage = extract_usage(payload.get("usage"))
        try:
            [choice] = payload["choices"]
            if choice.get("index") != 0 or not isinstance(choice["message"], dict):
                raise ValueError
            message = choice["message"]
            value = message.get("content")
            if message.get("tool_calls") or message.get("function_call") or message.get("audio"):
                raise ValueError
            finish = "content_filter" if message.get("refusal") else finish_reason(choice["finish_reason"])
            if not isinstance(value, str) and (value is not None or finish != "content_filter"):
                raise ValueError
            return ProviderResult(value, finish, usage)
        except (AttributeError, KeyError, TypeError, ValueError, ProviderFailure):
            raise replace(protocol_failure(), usage=usage) from None

    async def stream(self, deployment: Deployment, chat: Chat) -> AsyncIterator[ProviderEvent]:
        usage = None
        finish = None
        refused = False
        try:
            async with self.response(deployment, self.payload(deployment, chat), stream=True) as response:
                async for name, raw in events(response):
                    if raw == b"[DONE]":
                        if finish is None:
                            raise protocol_failure()
                        yield ProviderEvent(finish=finish, usage=usage)
                        return
                    payload = object_payload(raw)
                    if name == "error" or "error" in payload:
                        raise ProviderFailure("provider_error")
                    if payload.get("usage") is not None:
                        if usage is not None:
                            raise protocol_failure()
                        usage = extract_usage(payload["usage"])
                        yield ProviderEvent(usage=usage)
                    choices = payload["choices"]
                    if not choices:
                        if not isinstance(choices, list) or finish is None or usage is None:
                            raise protocol_failure()
                        continue
                    if finish is not None:
                        raise protocol_failure()
                    [choice] = choices
                    delta = choice["delta"]
                    if (
                        choice.get("index") != 0
                        or delta.get("tool_calls")
                        or delta.get("function_call")
                        or delta.get("audio")
                    ):
                        raise protocol_failure()
                    value = delta.get("content")
                    refused = refused or bool(delta.get("refusal"))
                    if value is not None and not isinstance(value, str):
                        raise protocol_failure()
                    if value:
                        yield ProviderEvent(text=value)
                    if choice["finish_reason"] is not None:
                        finish = "content_filter" if refused else finish_reason(choice["finish_reason"])
            raise protocol_failure()
        except ProviderFailure as exc:
            raise replace(exc, usage=usage) from None
        except (KeyError, TypeError, ValueError, AttributeError):
            raise replace(protocol_failure(), usage=usage) from None
