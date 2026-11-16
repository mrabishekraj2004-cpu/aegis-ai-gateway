import asyncio
from collections import OrderedDict
from contextlib import suppress
from dataclasses import dataclass
from importlib.resources import files
from math import ceil
from time import monotonic
from uuid import uuid4

from anyio import CancelScope
from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff
from redis.exceptions import RedisError

from aegis.contracts import Chat, Deployment, Principal
from aegis.errors import GatewayError
from aegis.settings import Settings

BUCKETS = (100, 250, 500, 1000, 1500, 2500, 4000, 8000, 16000, 30000, 60000, 90000)


@dataclass(frozen=True, slots=True)
class HealthSignal:
    p95_ms: int
    bad_ppm: int = 50_000
    samples: int = 0


@dataclass(frozen=True, slots=True)
class BreakerGrant:
    token: str
    generation: str
    probe: bool


def redis_down() -> GatewayError:
    return GatewayError(503, "admission_unavailable", "The distributed admission service is unavailable.")


class Lease:
    def __init__(self, controls: "Controls", key: str, owner: str, started: float) -> None:
        self.controls, self.key, self.owner = controls, key, owner
        self.expiry = started + 28
        self.lost = asyncio.get_running_loop().create_future()
        self.task = asyncio.create_task(self._renew())

    async def _renew(self) -> None:
        delay = 10.0
        try:
            while True:
                remaining = self.expiry - monotonic()
                if remaining <= 0:
                    return
                await asyncio.sleep(min(remaining, delay))
                started = monotonic()
                if started >= self.expiry:
                    return
                try:
                    ok = await self.controls.call("lease", [self.key], ["renew", self.owner, 0])
                except GatewayError:
                    delay = 0.5
                    continue
                if not ok or monotonic() >= self.expiry:
                    return
                self.expiry = started + 28
                delay = 10.0
        finally:
            if not self.lost.done():
                self.lost.set_result(None)

    def valid(self) -> bool:
        return not self.lost.done() and monotonic() < self.expiry

    async def close(self) -> None:
        self.task.cancel()
        with suppress(asyncio.CancelledError):
            await self.task
        with suppress(GatewayError):
            await self.controls.call("lease", [self.key], ["release", self.owner, 0])


class Controls:
    def __init__(self, settings: Settings, *, prefix: str | None = None) -> None:
        self.settings = settings
        self.prefix = prefix or f"ag:{settings.environment}:v1"
        url = settings.redis_url.get_secret_value()
        tls = {"ssl_check_hostname": True, "ssl_cert_reqs": "required"} if url.startswith("rediss://") else {}
        self.redis = Redis.from_url(
            url,
            decode_responses=True,
            socket_connect_timeout=0.1,
            socket_timeout=0.1,
            retry=Retry(NoBackoff(), 0),
            max_connections=128,
            **tls,
        )
        self.scripts = {
            name: self.redis.register_script(files("aegis").joinpath("sql", f"{name}.lua").read_text())
            for name in ("buckets", "lease", "breaker", "signal", "cooldown")
        }
        self.signal_cache: OrderedDict[tuple, tuple[float, HealthSignal]] = OrderedDict()

    async def call(self, name: str, keys: list, args: list):
        try:
            async with asyncio.timeout(0.12):
                return await self.scripts[name](keys=keys, args=args)
        except (RedisError, TimeoutError):
            raise redis_down() from None

    async def ready(self) -> bool:
        try:
            async with asyncio.timeout(0.12):
                return bool(await self.redis.ping())
        except (RedisError, TimeoutError):
            return False

    async def close(self) -> None:
        await self.redis.aclose()

    async def acquire(self, scope: str, bound: int) -> Lease | None:
        key = f"{self.prefix}:{{{scope}}}:flight"
        owner = uuid4().hex
        start = monotonic()
        granted = await self.call("lease", [key], ["acquire", owner, bound])
        return Lease(self, key, owner, start) if granted else None

    async def debit(self, principal: Principal, units: int) -> None:
        scope = f"{self.prefix}:{{t:{principal.tenant_id}}}:rate"
        key = f"{scope}:{principal.kind}:{principal.actor_id}"
        ok, delay = await self.call(
            "buckets",
            [f"{scope}:rpm", f"{scope}:units", f"{key}:rpm", f"{key}:units"],
            [120, 30, 1, 120000, 32000, units, 60, 15, 1, 60000, 20000, units],
        )
        if ok != 1:
            raise GatewayError(
                429,
                "rate_limit_exceeded",
                "Tenant or credential rate limit exceeded.",
                retry_after=delay or None,
            )

    async def retry_permitted(self, deployment: Deployment) -> bool:
        allowed, _ = await self.call(
            "buckets",
            [f"{self.prefix}:{{q:{deployment.quota_group}}}:retry"],
            [self.settings.retry_per_minute, 5, 1],
        )
        return allowed == 1

    def _breaker_key(self, deployment: Deployment) -> str:
        return f"{self.prefix}:{{d:{deployment.id}}}:breaker:{deployment.credential_revision}"

    def _cooldown_key(self, deployment: Deployment) -> str:
        return f"{self.prefix}:{{q:{deployment.quota_group}}}:cooldown"

    async def probe_state(self, deployment: Deployment) -> str:
        _, _, phase = await self.call(
            "breaker",
            [self._breaker_key(deployment), self._cooldown_key(deployment)],
            ["peek", uuid4().hex, "", self.settings.breaker_cold_seconds],
        )
        return phase

    async def grant(self, deployment: Deployment, remaining: float) -> BreakerGrant | None:
        token = uuid4().hex
        granted, generation, _ = await self.call(
            "breaker",
            [self._breaker_key(deployment), self._cooldown_key(deployment)],
            ["grant", token, "", self.settings.breaker_cold_seconds, min(95, max(1, ceil(remaining) + 5))],
        )
        return BreakerGrant(token, generation, granted == 2) if granted else None

    async def feedback(
        self,
        deployment: Deployment,
        grant: BreakerGrant,
        failure: bool | None,
        *,
        cooldown: int = 0,
    ) -> str:
        if cooldown:
            await self.call("cooldown", [self._cooldown_key(deployment)], [cooldown])
        state = "neutral" if failure is None else ("bad" if failure else "good")
        _, _, phase = await self.call(
            "breaker",
            [self._breaker_key(deployment)],
            ["result", grant.token, grant.generation, 0, 0, state, uuid4().hex],
        )
        return phase

    @staticmethod
    def _cohort(chat: Chat, latency_class: str) -> tuple[str, str]:
        return (
            "sse" if chat.stream else "json",
            f"{latency_class}:{int(chat.prompt_quota > 1024)}:{int(chat.output_ceiling > 128)}",
        )

    async def signal(self, deployment: Deployment, chat: Chat, latency_class: str) -> HealthSignal:
        mode, cohort = self._cohort(chat, latency_class)
        baseline = deployment.stream_baseline_ms if chat.stream else deployment.json_baseline_ms
        key = (deployment.id, deployment.version, mode, cohort)
        cached = self.signal_cache.get(key)
        now = monotonic()
        if cached and now - cached[0] < 5:
            self.signal_cache.move_to_end(key)
            return cached[1]
        try:
            total, bad, histogram = await self.call(
                "signal",
                [f"{self.prefix}:{{d:{deployment.id}}}:observation"],
                ["read", mode, cohort, *BUCKETS],
            )
        except GatewayError:
            return cached[1] if cached and now - cached[0] < 30 else HealthSignal(baseline)
        samples = sum(histogram)
        if samples >= 30:
            target = ceil(samples * 0.95)
            for edge, count in zip(BUCKETS, histogram, strict=True):
                target -= count
                if target <= 0:
                    baseline = edge
                    break
        signal = HealthSignal(baseline, (bad + 1) * 1_000_000 // (total + 20), samples)
        self.signal_cache[key] = (now, signal)
        self.signal_cache.move_to_end(key)
        if len(self.signal_cache) > 1024:
            self.signal_cache.popitem(last=False)
        return signal

    async def observe(
        self,
        deployment: Deployment,
        chat: Chat,
        latency_class: str,
        failure: bool,
        duration_ms: int,
    ) -> None:
        mode, cohort = self._cohort(chat, latency_class)
        bucket = next((edge for edge in BUCKETS if duration_ms <= edge), BUCKETS[-1])
        await self.call(
            "signal",
            [f"{self.prefix}:{{d:{deployment.id}}}:observation"],
            ["write", mode, cohort, int(failure), "" if failure else bucket],
        )


async def close_leases(*leases: Lease | None) -> None:
    with CancelScope(shield=True):
        for held in leases:
            if held:
                await held.close()
