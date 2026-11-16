import json
from dataclasses import replace

import httpx
import pytest
from test_routing_and_contracts import MESSAGE, deployment

from aegis.contracts import Chat
from aegis.errors import ProviderFailure
from aegis.providers.anthropic import Anthropic
from aegis.providers.mock import Mock
from aegis.providers.openai import OpenAI

URL = "https://upstream.example.test/completions"


class Chunks(httpx.AsyncByteStream):
    def __init__(self, content: bytes) -> None:
        self.content = content

    async def __aiter__(self):
        for index in range(0, len(self.content), 5):
            yield self.content[index : index + 5]


def sse(*events: tuple[str | None, dict | str]) -> bytes:
    return b"".join(
        (f"event: {name}\r\n".encode() if name else b"")
        + b"data: "
        + (data.encode() if isinstance(data, str) else json.dumps(data, ensure_ascii=False).encode())
        + b"\r\n\r\n"
        for name, data in events
    )


def openai_chunk(value=None, finish=None) -> dict:
    return {
        "choices": [
            {"delta": {} if value is None else {"content": value}, "index": 0, "finish_reason": finish}
        ]
    }


@pytest.mark.parametrize("kind", ["json", "stream"])
async def test_openai_payload_and_normalized_usage(kind):
    stream = kind == "stream"
    chat = Chat(model="auto", messages=MESSAGE, stream=stream)
    route = replace(deployment(), provider="openai", credential_ref="fixture", upstream_model="registered-id")
    billed = {
        "prompt_tokens": 5,
        "completion_tokens": 2,
        "total_tokens": 7,
        "prompt_tokens_details": {"cached_tokens": 1},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer fixture-secret"
        payload = json.loads(request.content)
        assert payload["model"] == "registered-id" and payload["max_completion_tokens"] == 256
        if stream:
            assert payload["stream_options"]["include_usage"]
            packed = sse(
                (None, openai_chunk("x✓")),
                (None, openai_chunk(finish="stop")),
                (None, {"choices": [], "usage": billed}),
                (None, "[DONE]"),
            )
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Chunks(packed))
        return httpx.Response(
            200,
            json={
                "choices": [{"index": 0, "message": {"content": "x✓"}, "finish_reason": "stop"}],
                "usage": billed,
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = OpenAI(client, URL, {"fixture": "fixture-secret"})
        if stream:
            body = [event async for event in provider.stream(route, chat)]
            assert body[0].text == "x✓" and body[-1].finish == "stop"
            usage = body[-1].usage
        else:
            result = await provider.complete(route, chat)
            assert result.text == "x✓" and result.finish == "stop"
            usage = result.usage
    assert usage.public() == {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}
    assert usage.cache_read == 1


async def test_anthropic_maps_system_and_cumulative_usage():
    chat = Chat(
        model="auto",
        stream=True,
        messages=[
            {"role": "system", "content": "system"},
            *MESSAGE,
            {"role": "user", "content": "again"},
        ],
    )
    route = replace(
        deployment(), provider="anthropic", credential_ref="fixture", upstream_model="registered-id"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["anthropic-version"] == "2023-06-01"
        assert request.headers["x-api-key"] == "fixture-secret"
        payload = json.loads(request.content)
        assert payload["system"] == "system" and payload["messages"] == [
            {"role": "user", "content": "hello\nagain"}
        ]
        packed = sse(
            *[
                (event["type"], event)
                for event in [
                    {
                        "type": "message_start",
                        "message": {
                            "usage": {
                                "input_tokens": 4,
                                "cache_read_input_tokens": 2,
                                "cache_creation_input_tokens": 3,
                                "output_tokens": 1,
                            }
                        },
                    },
                    {"type": "ping"},
                    {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "text", "text": ""},
                    },
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "α"}},
                    {"type": "content_block_stop", "index": 0},
                    {
                        "type": "message_delta",
                        "delta": {"stop_reason": "max_tokens"},
                        "usage": {"output_tokens": 8},
                    },
                    {"type": "message_stop"},
                ]
            ]
        )
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Chunks(packed))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        body = [
            event async for event in Anthropic(client, URL, {"fixture": "fixture-secret"}).stream(route, chat)
        ]
    assert body[0].text == "α"
    assert body[-1].finish == "length"
    assert body[-1].usage.components() == {"input": 4, "output": 8, "cache_read": 2, "cache_write": 3}


@pytest.mark.parametrize(
    ("status", "code", "cooldown"),
    [
        (429, "provider_overloaded", 7),
        (403, "provider_error", 0),
        (503, "provider_error", 0),
    ],
)
async def test_http_status_classification(status, code, cooldown):
    route = replace(deployment(), provider="openai", credential_ref="fixture")
    chat = Chat(model="auto", messages=MESSAGE)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(status, headers={"retry-after": "7"}, text="never disclose")
        )
    ) as client:
        with pytest.raises(ProviderFailure) as result:
            await OpenAI(client, URL, {"fixture": "key"}).complete(route, chat)
    assert result.value.code == code and result.value.cooldown == cooldown
    assert not result.value.unsent


async def test_truncated_provider_stream_is_not_success():
    route = replace(deployment(), provider="openai", credential_ref="fixture")
    chat = Chat(model="auto", messages=MESSAGE, stream=True)
    packed = sse((None, openai_chunk("partial")), (None, openai_chunk(finish="stop")))
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200, headers={"content-type": "text/event-stream"}, stream=Chunks(packed)
            )
        )
    ) as client:
        iterator = OpenAI(client, URL, {"fixture": "key"}).stream(route, chat)
        assert (await anext(iterator)).text == "partial"
        with pytest.raises(ProviderFailure, match="provider_protocol_error"):
            await anext(iterator)


async def test_mock_is_deterministic_and_stream_matches_json():
    mock = Mock()
    chat = Chat(model="mock-chat", messages=MESSAGE)
    route = deployment()
    result = await mock.complete(route, chat)
    assert await mock.complete(route, chat) == result
    stream = [event async for event in mock.stream(route, chat)]
    assert "".join(item.text or "" for item in stream) == result.text
    assert stream[-1].usage == result.usage
