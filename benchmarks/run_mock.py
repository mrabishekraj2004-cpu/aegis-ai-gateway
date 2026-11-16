"""Run credential-free load against two Uvicorn processes and disposable shared services."""

import argparse
import asyncio
import json
import os
import platform
import secrets
import subprocess
import sys
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic, sleep

import httpx
from aegis.admin import provision_demo
from aegis.database import Database
from aegis.settings import Settings
from prometheus_client.parser import text_string_to_metric_families


async def seed(settings: Settings, admin_url: str, count: int) -> list[str]:
    database = Database(settings, admin_url)
    try:
        slug = "qa-" + secrets.token_hex(6)
        return [
            (await provision_demo(database, settings, f"{slug}-{index}", 5_000_000))[
                "api_key"
            ]
            for index in range(count)
        ]
    finally:
        await database.close()


def ready(client: httpx.Client, host: str, worker: subprocess.Popen) -> None:
    deadline = monotonic() + 12
    while monotonic() < deadline and worker.poll() is None:
        try:
            if client.get(host + "/v1/health").status_code == 200:
                return
        except httpx.RequestError:
            pass
        sleep(0.1)
    raise RuntimeError("Gateway failed readiness. Inspect the local worker log.")


def stop(worker: subprocess.Popen) -> None:
    if worker.poll() is None:
        worker.terminate()
        try:
            worker.wait(timeout=8)
        except subprocess.TimeoutExpired:
            worker.kill()
            worker.wait()


def measurements(
    client: httpx.Client, hosts: list[str], token: str
) -> dict[str, float]:
    totals: dict[str, float] = {}
    for host in hosts:
        reply = client.get(
            host + "/v1/metrics", headers={"Authorization": "Bearer " + token}
        )
        reply.raise_for_status()
        for family in text_string_to_metric_families(reply.text):
            for sample in family.samples:
                if sample.name.startswith(
                    (
                        "aegis_routing_evaluation_seconds_",
                        "aegis_gateway_admission_seconds_",
                    )
                ) and sample.name.endswith(("_sum", "_count")):
                    key = f"{sample.labels['mode']}:{sample.name}"
                    totals[key] = totals.get(key, 0) + sample.value
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--locust", default="locust")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--users", type=int, nargs="+", default=[4, 16])
    parser.add_argument("--duration", type=int, default=20)
    parser.add_argument("--tenants", type=int, default=251)
    parser.add_argument("--port", type=int, default=18101)
    args = parser.parse_args()
    if (
        any(not 1 <= count <= 48 for count in args.users)
        or len(set(args.users)) != len(args.users)
        or not 3 <= args.duration <= 240
        or not 1 <= args.tenants <= 401
        or not 1024 <= args.port <= 65534
    ):
        parser.error(
            "Use distinct 1–48 user counts, 1–401 tenants, a 3–240 second duration and two local ports."
        )
    args.output.mkdir(parents=True, exist_ok=False)
    admin_url = os.environ["AEGIS_TEST_ADMIN_URL"]
    collector = secrets.token_hex(36)
    fields = {
        "AEGIS_ENVIRONMENT": "test",
        "AEGIS_DATABASE_URL": os.environ["AEGIS_TEST_DATABASE_URL"],
        "AEGIS_REDIS_URL": os.environ["AEGIS_TEST_REDIS_URL"],
        "AEGIS_KEY_PEPPERS": json.dumps({"v1": secrets.token_hex(36)}),
        "AEGIS_ACTIVE_PEPPER": "v1",
        "AEGIS_CURSOR_SECRET": secrets.token_hex(36),
        "AEGIS_METRICS_TOKEN": collector,
        "AEGIS_PROVIDER_CREDENTIALS": "{}",
        "AEGIS_TRACE_SAMPLE_RATE": "0",
        "AEGIS_BREAKER_COLD_SECONDS": "0",
    }
    os.environ.update(fields)
    for key in (
        "AEGIS_TRACE_ENDPOINT",
        "AEGIS_OIDC_ISSUER",
        "AEGIS_OIDC_AUDIENCE",
        "AEGIS_OIDC_JWKS_URL",
    ):
        os.environ.pop(key, None)
    keys = asyncio.run(seed(Settings(), admin_url, args.tenants))
    hosts = [f"http://127.0.0.1:{args.port + index}" for index in range(2)]
    locust_env = {
        key: value for key, value in os.environ.items() if not key.startswith("AEGIS_")
    }
    locust_env.update(
        AEGIS_BENCHMARK_KEYS=json.dumps(keys),
        AEGIS_BENCHMARK_REPLICA=hosts[1],
        NO_PROXY="127.0.0.1,localhost",
        no_proxy="127.0.0.1,localhost",
    )
    profiles = []
    with ExitStack() as stack:
        client = stack.enter_context(httpx.Client(timeout=2, trust_env=False))
        for index, host in enumerate(hosts):
            log = stack.enter_context((args.output / f"replica-{index}.log").open("w"))
            worker = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "aegis.main:create_app",
                    "--factory",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(args.port + index),
                    "--no-access-log",
                    "--no-proxy-headers",
                ],
                stdout=log,
                stderr=log,
            )
            stack.callback(stop, worker)
            ready(client, host, worker)
        for users in args.users:
            before = measurements(client, hosts, collector)
            start = monotonic()
            result = subprocess.run(
                [
                    args.locust,
                    "-f",
                    str(Path(__file__).with_name("locustfile.py")),
                    "--host",
                    hosts[0],
                    "--headless",
                    "-u",
                    str(users),
                    "-r",
                    str(users),
                    "-t",
                    f"{args.duration}s",
                    "--stop-timeout",
                    "5",
                    "--csv",
                    str(args.output / f"users-{users}"),
                    "--json-file",
                    str(args.output / f"users-{users}-final"),
                    "--only-summary",
                ],
                env=locust_env,
                check=False,
            )
            after = measurements(client, hosts, collector)
            profiles.append(
                {
                    "users": users,
                    "exit_code": result.returncode,
                    "elapsed_seconds": monotonic() - start,
                    "metrics": {
                        key: value - before.get(key, 0) for key, value in after.items()
                    },
                }
            )
    (args.output / "run.json").write_text(
        json.dumps(
            {
                "recorded_at": datetime.now(UTC).isoformat(),
                "duration_seconds": args.duration,
                "python": platform.python_version(),
                "kernel": platform.release(),
                "arch": platform.machine(),
                "logical_cpus": os.cpu_count(),
                "tenants": args.tenants,
                "replicas": len(hosts),
                "profiles": profiles,
            },
            indent=2,
        )
        + "\n"
    )
    return int(any(profile["exit_code"] for profile in profiles))


if __name__ == "__main__":
    raise SystemExit(main())
