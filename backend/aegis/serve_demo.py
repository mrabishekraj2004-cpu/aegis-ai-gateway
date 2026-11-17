"""Run the gateway and reconciliation together on a single demo instance."""

import asyncio
import os
import signal
import sys
from asyncio.subprocess import Process
from contextlib import suppress


async def stop(processes: list[Process]) -> None:
    for process in processes:
        if process.returncode is None:
            with suppress(ProcessLookupError):
                process.terminate()
    try:
        async with asyncio.timeout(27):
            await asyncio.gather(*(process.wait() for process in processes))
    except TimeoutError:
        for process in processes:
            if process.returncode is None:
                with suppress(ProcessLookupError):
                    process.kill()
        await asyncio.gather(*(process.wait() for process in processes))


async def serve() -> int:
    gateway_env = os.environ.copy()
    worker_database = gateway_env.pop("AEGIS_WORKER_DATABASE_URL")
    worker_env = {name: value for name, value in gateway_env.items() if not name.startswith("AEGIS_")}
    for name in ("AEGIS_ENVIRONMENT", "AEGIS_TRACE_ENDPOINT", "AEGIS_TRACE_SAMPLE_RATE"):
        if name in gateway_env:
            worker_env[name] = gateway_env[name]
    worker_env.update(AEGIS_DATABASE_URL=worker_database, AEGIS_DB_POOL_SIZE="2")

    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for event in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(event, stopping.set)

    processes = []
    tasks = []
    try:
        processes.append(
            await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "uvicorn",
                "aegis.main:create_app",
                "--factory",
                "--host",
                "0.0.0.0",
                "--port",
                gateway_env.get("PORT", "8080"),
                "--no-access-log",
                "--no-proxy-headers",
                "--timeout-graceful-shutdown",
                "25",
                env=gateway_env,
            )
        )
        processes.append(await asyncio.create_subprocess_exec("aegis-worker", env=worker_env))
        shutdown = asyncio.create_task(stopping.wait())
        tasks = [shutdown, *(asyncio.create_task(process.wait()) for process in processes)]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        if shutdown in done:
            return 0
        print("An Aegis process exited unexpectedly. Stopping the demo instance.", file=sys.stderr)
        return 1
    finally:
        await stop(processes)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    if not os.environ.get("AEGIS_WORKER_DATABASE_URL"):
        raise SystemExit("AEGIS_WORKER_DATABASE_URL is required for the hosted demo.")
    sys.exit(asyncio.run(serve()))
