import os
import secrets
from dataclasses import dataclass
from uuid import uuid4

import httpx
import pytest

from aegis.admin import provision_demo
from aegis.api import create_app
from aegis.database import Database
from aegis.settings import Settings


@pytest.fixture
def settings():
    seed = secrets.token_hex(24)
    return Settings(
        environment="test",
        database_url=os.getenv("AEGIS_TEST_DATABASE_URL", "postgresql+psycopg://unused@localhost/test"),
        redis_url=os.getenv("AEGIS_TEST_REDIS_URL", "redis://localhost:6379/0"),
        key_peppers={"v1": "test-pepper-" + seed},
        cursor_secret="cursor-" + seed,
        metrics_token="metrics-" + seed,
        oidc_issuer="https://idp.example.test",
        oidc_audience="aegis-test",
        oidc_jwks_url="https://idp.example.test/jwks",
        trace_sample_rate=1,
        breaker_cold_seconds=0,
    )


@dataclass
class Runtime:
    app: object
    admin: Database
    http: httpx.AsyncClient
    settings: Settings

    async def seed(self, cap: int = 1_000_000) -> dict:
        return await provision_demo(self.admin, self.settings, "suite-" + uuid4().hex, cap)

    @staticmethod
    def headers(seed: dict) -> dict[str, str]:
        return {"Authorization": "Bearer " + seed["api_key"]}


@pytest.fixture
async def runtime(settings):
    required = ("AEGIS_TEST_DATABASE_URL", "AEGIS_TEST_ADMIN_URL", "AEGIS_TEST_REDIS_URL")
    if not all(os.getenv(name) for name in required):
        pytest.skip("Provide disposable PostgreSQL and Redis test URLs listed in the README.")
    admin = Database(settings, os.environ["AEGIS_TEST_ADMIN_URL"])
    app = create_app(settings)
    try:
        async with app.router.lifespan_context(app):
            app.state.gateway.controls.prefix = "aegis:suite:" + uuid4().hex
            transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
            async with httpx.AsyncClient(transport=transport, base_url="http://asgi.test") as http:
                yield Runtime(app, admin, http, settings)
    finally:
        await admin.close()
