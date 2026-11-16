"""Closed-loop workload with portable, deterministic tenant and replica selection."""

import itertools
import json
import os
import re

from locust import HttpUser, task

OPERATIONS = (
    "json",
    "json",
    "sse",
    "json",
    "models",
    "json",
    "sse",
    "json",
    "json",
    "json",
)
ORDINALS = itertools.count()
CHAT = {
    "model": "mock-chat",
    "messages": [
        {
            "role": "user",
            "content": "Measure Aegis using the deterministic mock adapter.",
        }
    ],
    "max_tokens": 5,
}


class GatewayUser(HttpUser):
    def on_start(self):
        self.keys = json.loads(os.environ["AEGIS_BENCHMARK_KEYS"])
        self.secondary = os.environ["AEGIS_BENCHMARK_REPLICA"]

    @task
    def run_operation(self):
        ordinal = next(ORDINALS)
        operation = OPERATIONS[ordinal % len(OPERATIONS)]
        origin = (
            self.secondary if (ordinal + ordinal // len(OPERATIONS)) % 2 else self.host
        )
        headers = {"Authorization": "Bearer " + self.keys[ordinal % len(self.keys)]}
        streaming = operation == "sse"
        if operation == "models":
            result = self.client.get(
                origin + "/v1/models",
                name=operation,
                headers=headers,
                timeout=5,
                catch_response=True,
            )
        else:
            payload = {**CHAT, "stream": streaming}
            if streaming:
                payload["stream_options"] = {"include_usage": True}
            result = self.client.post(
                origin + "/v1/chat/completions",
                name=operation,
                headers=headers,
                json=payload,
                timeout=5,
                catch_response=True,
            )
        with result as response:
            if response.status_code != 200:
                try:
                    code = response.json()["error"]["code"]
                except (ValueError, KeyError, TypeError):
                    code = ""
                safe = (
                    code
                    if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,48}", code)
                    else "unknown"
                )
                response.failure(f"HTTP {response.status_code} {safe}")
            elif streaming:
                if (
                    response.text.count("data: [DONE]") != 1
                    or "event: error" in response.text
                ):
                    response.failure("Stream did not complete")
            elif operation == "models":
                if not any(
                    row["id"] == CHAT["model"] for row in response.json()["data"]
                ):
                    response.failure("Mock alias missing")
            elif not response.json().get("usage"):
                response.failure("Reported usage missing")
