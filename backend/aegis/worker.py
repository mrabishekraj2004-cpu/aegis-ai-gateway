import asyncio
import signal
from contextlib import suppress

from sqlalchemy.exc import SQLAlchemyError

from aegis.accounting import Accounting
from aegis.database import Database
from aegis.settings import RuntimeSettings
from aegis.telemetry import Telemetry, configure_logging, logger


async def run(settings: RuntimeSettings) -> None:
    database = Database(settings)
    telemetry = Telemetry(settings)
    halt = asyncio.Event()
    loop = asyncio.get_running_loop()
    for event in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(event, halt.set)
    try:
        await database.verify("aegis_worker")
        accounting = Accounting(database)
        while not halt.is_set():
            try:
                with telemetry.span("aegis.reconcile"):
                    count = await accounting.reconcile()
                if count:
                    logger.info("reconciled_attempts", extra={"count": count})
            except SQLAlchemyError:
                logger.warning("reconciliation_database_unavailable")
            with suppress(TimeoutError):
                await asyncio.wait_for(halt.wait(), timeout=5)
    finally:
        await database.close()
        telemetry.provider.shutdown()


def main() -> None:
    configure_logging()
    asyncio.run(run(RuntimeSettings()))
