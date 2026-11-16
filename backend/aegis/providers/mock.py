import asyncio
from collections.abc import AsyncIterator
from hashlib import sha256

from aegis.contracts import Chat, Deployment, Finish, ProviderEvent, ProviderResult, TokenUsage
from aegis.errors import ProviderFailure


class Mock:
    @staticmethod
    def result(chat: Chat, *, missing: bool) -> ProviderResult:
        canonical = chat.model_dump_json(include={"messages"}).encode()
        checksum = sha256(canonical).hexdigest()[:12]
        words = ["Aegis", "mock", "result", checksum, "✓"]
        text = " ".join(words[: chat.output_ceiling])
        finish: Finish = "length" if chat.output_ceiling < len(words) else "stop"
        stops = [chat.stop] if isinstance(chat.stop, str) else chat.stop or []
        positions = [position for stop in stops if (position := text.find(stop)) >= 0]
        if positions:
            text = text[: min(positions)]
            finish = "stop"
        return ProviderResult(
            text,
            finish,
            None
            if missing
            else TokenUsage(prompt_tokens=chat.prompt_quota, completion_tokens=len(text.split())),
        )

    async def complete(self, deployment: Deployment, chat: Chat) -> ProviderResult:
        if deployment.upstream_model == "fail-unsent":
            raise ProviderFailure("provider_error", unsent=True)
        if deployment.upstream_model in {"fail-ambiguous", "fail-after-text"}:
            raise ProviderFailure("provider_error")
        return self.result(chat, missing=deployment.upstream_model == "missing-usage")

    async def stream(self, deployment: Deployment, chat: Chat) -> AsyncIterator[ProviderEvent]:
        if deployment.upstream_model == "fail-after-text":
            yield ProviderEvent(text="Aegis partial")
            await asyncio.sleep(0)
            raise ProviderFailure("provider_error")
        result = await self.complete(deployment, chat)
        for index in range(0, len(result.text or ""), 8):
            await asyncio.sleep(0)
            yield ProviderEvent(text=result.text[index : index + 8])
        yield ProviderEvent(finish=result.finish, usage=result.usage)
