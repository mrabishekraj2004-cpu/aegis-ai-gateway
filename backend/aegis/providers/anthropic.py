from collections.abc import AsyncIterator
from dataclasses import replace

from aegis.contracts import Chat, Deployment, Finish, ProviderEvent, ProviderResult, TokenUsage
from aegis.errors import ProviderFailure
from aegis.providers.base import HTTPProvider, events, object_payload, protocol_failure, read_json


def finish_reason(value: object) -> Finish:
    match value:
        case "end_turn" | "stop_sequence":
            return "stop"
        case "max_tokens":
            return "length"
        case "refusal":
            return "content_filter"
        case _:
            raise protocol_failure()


def extract_usage(value: dict) -> TokenUsage | None:
    if "input_tokens" not in value or "output_tokens" not in value:
        return None
    read = value.get("cache_read_input_tokens", 0)
    write = value.get("cache_creation_input_tokens", 0)
    uncached = value["input_tokens"]
    if any(type(count) is not int or count < 0 for count in (read, write, uncached)):
        raise protocol_failure()
    return TokenUsage(
        prompt_tokens=uncached + read + write,
        completion_tokens=value["output_tokens"],
        cache_read=read,
        cache_write=write,
    )


class Anthropic(HTTPProvider):
    def auth_headers(self, credential: str) -> dict[str, str]:
        return {"x-api-key": credential, "anthropic-version": "2023-06-01"}

    @staticmethod
    def payload(deployment: Deployment, chat: Chat) -> dict:
        messages: list[dict[str, str]] = []
        result = {
            "model": deployment.upstream_model,
            "max_tokens": chat.output_ceiling,
            "stream": chat.stream,
            "messages": messages,
        }
        for message in chat.messages:
            if message.role == "system":
                result["system"] = message.content
            elif messages and messages[-1]["role"] == message.role:
                messages[-1]["content"] += "\n" + message.content
            else:
                messages.append(message.model_dump())
        if chat.stop is not None:
            result["stop_sequences"] = [chat.stop] if isinstance(chat.stop, str) else chat.stop
        for key in ("temperature", "top_p"):
            if (value := getattr(chat, key)) is not None:
                result[key] = value
        return result

    async def complete(self, deployment: Deployment, chat: Chat) -> ProviderResult:
        async with self.response(deployment, self.payload(deployment, chat), stream=False) as response:
            payload = await read_json(response)
        usage = None
        try:
            usage = extract_usage(payload.get("usage") or {})
            finish = finish_reason(payload["stop_reason"])
            text = []
            for block in payload["content"]:
                if block["type"] != "text" or not isinstance(block["text"], str):
                    raise protocol_failure()
                text.append(block["text"])
            return ProviderResult(
                None if not text and finish == "content_filter" else "".join(text), finish, usage
            )
        except (AttributeError, KeyError, TypeError, ValueError, ProviderFailure):
            raise replace(protocol_failure(), usage=usage) from None

    async def stream(self, deployment: Deployment, chat: Chat) -> AsyncIterator[ProviderEvent]:
        usage_fields: dict = {}
        usage = None
        finish = None
        started = False
        open_blocks: set[int] = set()
        try:
            async with self.response(deployment, self.payload(deployment, chat), stream=True) as response:
                async for name, raw in events(response):
                    data = object_payload(raw)
                    kind = data["type"]
                    if name and name != kind:
                        raise protocol_failure()
                    if kind == "error":
                        upstream_type = data.get("error", {}).get("type")
                        if upstream_type in {"overloaded_error", "rate_limit_error"}:
                            raise ProviderFailure("provider_overloaded", 503, cooldown=1)
                        raise ProviderFailure("provider_error")
                    if kind == "ping":
                        continue
                    if kind == "message_start":
                        if started:
                            raise protocol_failure()
                        started = True
                        usage_fields.update(data["message"].get("usage", {}))
                        continue
                    if not started:
                        raise protocol_failure()
                    if kind == "content_block_start":
                        block = data["content_block"]
                        index = data["index"]
                        if finish or type(index) is not int or not 0 <= index < 256 or index in open_blocks:
                            raise protocol_failure()
                        value = block.get("text")
                        if block.get("type") != "text" or not isinstance(value, str):
                            raise protocol_failure()
                        open_blocks.add(index)
                        if value:
                            yield ProviderEvent(text=value)
                    elif kind == "content_block_delta":
                        delta = data["delta"]
                        if data["index"] not in open_blocks or delta.get("type") != "text_delta":
                            raise protocol_failure()
                        value = delta["text"]
                        if not isinstance(value, str):
                            raise protocol_failure()
                        if value:
                            yield ProviderEvent(text=value)
                    elif kind == "content_block_stop":
                        open_blocks.remove(data["index"])
                    elif kind == "message_delta":
                        if open_blocks or finish:
                            raise protocol_failure()
                        finish = finish_reason(data["delta"]["stop_reason"])
                        usage_fields.update(data.get("usage", {}))
                        # Accept cumulative billed output only once a finish delta arrives.
                        usage = (
                            extract_usage(usage_fields) if "output_tokens" in data.get("usage", {}) else None
                        )
                        if usage:
                            yield ProviderEvent(usage=usage)
                    elif kind == "message_stop":
                        if finish is None or open_blocks:
                            raise protocol_failure()
                        yield ProviderEvent(finish=finish, usage=usage)
                        return
            raise protocol_failure()
        except ProviderFailure as exc:
            raise replace(exc, usage=usage) from None
        except (AttributeError, KeyError, TypeError, ValueError):
            raise replace(protocol_failure(), usage=usage) from None
