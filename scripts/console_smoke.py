"""Serve the production console and a disposable gateway for live Playwright tests."""

import argparse
import asyncio
import json
import os
import secrets
import subprocess
import sys
from contextlib import ExitStack, asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic, sleep
from uuid import UUID, uuid4

import httpx
import jwt
import sqlalchemy as sa
from aegis import models as db
from aegis.admin import provision_demo
from aegis.api import create_app
from aegis.database import Database
from aegis.settings import Settings
from cryptography.hazmat.primitives.asymmetric import rsa


def fixture_app():
    settings = Settings()
    if settings.environment != "test" or settings.provider_credentials:
        raise RuntimeError(
            "The Playwright gateway requires the credential-free test environment."
        )
    app = create_app(settings)
    startup = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with startup(application):
            app.state.auth.jwks["browser-test"] = jwt.PyJWK.from_dict(
                json.loads(os.environ["AEGIS_BROWSER_JWK"]), algorithm="RS256"
            )
            app.state.auth.cached_at = monotonic()
            yield

    app.router.lifespan_context = lifespan
    return app


async def provision(settings: Settings, admin_url: str) -> tuple[str, str, str]:
    database = Database(settings, admin_url)
    try:
        slug = "smoke-" + secrets.token_hex(6)
        service = await provision_demo(database, settings, slug + "-sdk")
        member = await provision_demo(database, settings, slug + "-oidc")
        identity, subject = uuid4(), str(uuid4())
        async with database.transaction() as connection:
            await connection.execute(
                sa.insert(db.users).values(
                    id=identity, issuer=settings.oidc_issuer, subject=subject
                )
            )
            await connection.execute(
                sa.insert(db.memberships).values(
                    tenant_id=UUID(member["tenant_id"]), user_id=identity, role="owner"
                )
            )
        return service["api_key"], member["tenant_id"], subject
    finally:
        await database.close()


def stop(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--logs", type=Path, required=True, help="new local directory for service logs"
    )
    parser.add_argument("--gateway-port", type=int, default=18094)
    args = parser.parse_args()
    if not 1024 <= args.gateway_port <= 65535:
        parser.error("Use a port from 1024 through 65535.")
    root = Path(__file__).resolve().parents[1]
    if not (root / "frontend/out/index.html").exists():
        parser.error("Build the frontend export before running Playwright.")
    args.logs.mkdir(parents=True, exist_ok=False)
    issuer, audience = "https://identity.example.test", "aegis-local-console"
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key())
    gateway_env = {
        "AEGIS_ENVIRONMENT": "test",
        "AEGIS_DATABASE_URL": os.environ["AEGIS_TEST_DATABASE_URL"],
        "AEGIS_REDIS_URL": os.environ["AEGIS_TEST_REDIS_URL"],
        "AEGIS_KEY_PEPPERS": json.dumps({"v1": secrets.token_hex(36)}),
        "AEGIS_ACTIVE_PEPPER": "v1",
        "AEGIS_CURSOR_SECRET": secrets.token_hex(36),
        "AEGIS_PROVIDER_CREDENTIALS": "{}",
        "AEGIS_BREAKER_COLD_SECONDS": "0",
        "AEGIS_OIDC_ISSUER": issuer,
        "AEGIS_OIDC_AUDIENCE": audience,
        "AEGIS_OIDC_JWKS_URL": issuer + "/jwks",
        "AEGIS_ALLOWED_ORIGINS": '["http://127.0.0.1:3100"]',
        "AEGIS_BROWSER_JWK": public,
    }
    base_env = {
        key: value for key, value in os.environ.items() if not key.startswith("AEGIS_")
    }
    test_admin = os.environ["AEGIS_TEST_ADMIN_URL"]
    worker_url = os.getenv("AEGIS_TEST_WORKER_URL")
    settings = Settings(
        environment="test",
        database_url=gateway_env["AEGIS_DATABASE_URL"],
        redis_url=gateway_env["AEGIS_REDIS_URL"],
        key_peppers=json.loads(gateway_env["AEGIS_KEY_PEPPERS"]),
        active_pepper="v1",
        cursor_secret=gateway_env["AEGIS_CURSOR_SECRET"],
        oidc_issuer=issuer,
        oidc_audience=audience,
        oidc_jwks_url=issuer + "/jwks",
        provider_credentials={},
    )
    api_key, tenant, subject = asyncio.run(provision(settings, test_admin))
    now = int(datetime.now(UTC).timestamp())
    access_token = jwt.encode(
        {"iss": issuer, "aud": audience, "sub": subject, "iat": now, "exp": now + 600},
        private,
        algorithm="RS256",
        headers={"kid": "browser-test", "typ": "at+jwt"},
    )
    origin = f"http://127.0.0.1:{args.gateway_port}"
    browser_env = {
        **base_env,
        "AEGIS_E2E_URL": origin,
        "AEGIS_E2E_KEY": api_key,
        "AEGIS_E2E_TENANT": tenant,
        "AEGIS_E2E_ACCESS_TOKEN": access_token,
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
    }
    with ExitStack() as stack:
        gateway_log = stack.enter_context((args.logs / "gateway.log").open("w"))
        gateway = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "console_smoke:fixture_app",
                "--factory",
                "--app-dir",
                str(root / "scripts"),
                "--host",
                "127.0.0.1",
                "--port",
                str(args.gateway_port),
                "--no-access-log",
                "--no-proxy-headers",
            ],
            cwd=root,
            stdout=gateway_log,
            stderr=gateway_log,
            env={**base_env, **gateway_env},
        )
        stack.callback(stop, gateway)
        worker = None
        if worker_url:
            worker_log = stack.enter_context((args.logs / "worker.log").open("w"))
            worker = subprocess.Popen(
                [sys.executable, "-c", "from aegis.worker import main; main()"],
                stdout=worker_log,
                stderr=worker_log,
                env={
                    **base_env,
                    "AEGIS_DATABASE_URL": worker_url,
                    "AEGIS_ENVIRONMENT": "test",
                },
            )
            stack.callback(stop, worker)
        with httpx.Client(timeout=1, trust_env=False) as client:
            deadline = monotonic() + 15
            while monotonic() < deadline and gateway.poll() is None:
                try:
                    if client.get(origin + "/v1/health").status_code == 200:
                        break
                except httpx.RequestError:
                    pass
                sleep(0.1)
            else:
                raise RuntimeError("Local gateway failed readiness. See gateway.log.")
        result = subprocess.run(
            ["npm", "--prefix", "frontend", "run", "test:browser"],
            env=browser_env,
            cwd=root,
            check=False,
        )
        if worker is not None and worker.poll() is not None:
            raise RuntimeError(
                "The reconciliation worker exited during the smoke test. See worker.log."
            )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
