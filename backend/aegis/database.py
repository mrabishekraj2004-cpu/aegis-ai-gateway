from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from aegis.settings import RuntimeSettings

SCHEMA_VERSION = "001_core"
CATALOG_LOCK = 647309268571188


class Database:
    def __init__(self, settings: RuntimeSettings, url: str | None = None) -> None:
        self.engine = create_async_engine(
            url or settings.database_url.get_secret_value(),
            pool_size=settings.db_pool_size,
            max_overflow=0,
            pool_timeout=0.15,
            pool_pre_ping=True,
            connect_args={"connect_timeout": 2},
            hide_parameters=True,
        )

    @asynccontextmanager
    async def transaction(self, tenant: UUID | None = None) -> AsyncIterator[AsyncConnection]:
        async with self.engine.begin() as connection:
            await connection.execute(
                text(
                    "SELECT set_config('statement_timeout', '150ms', true), "
                    "set_config('lock_timeout', '100ms', true), set_config('aegis.tenant', :tenant, true)"
                ),
                {"tenant": str(tenant) if tenant else ""},
            )
            yield connection

    async def verify(self, role: str = "aegis_runtime") -> None:
        async with self.transaction() as connection:
            permitted = await connection.scalar(
                text("""
                SELECT NOT r.rolsuper AND NOT r.rolbypassrls
                  AND pg_has_role(current_user, :role, 'member')
                  AND NOT pg_has_role(current_user, :separate_role, 'member')
                  AND NOT pg_has_role(current_user, 'aegis_admin', 'member')
                  AND NOT pg_has_role(current_user, 'aegis_lookup', 'member')
                  AND NOT pg_has_role(current_user, pg_get_userbyid(n.nspowner), 'member')
                FROM pg_roles r CROSS JOIN pg_namespace n
                WHERE r.rolname = current_user AND n.nspname = 'aegis'
            """),
                {
                    "role": role,
                    "separate_role": "aegis_worker" if role == "aegis_runtime" else "aegis_runtime",
                },
            )
            installed = await connection.scalar(text("SELECT version_num FROM public.alembic_version"))
            if not permitted or installed != SCHEMA_VERSION:
                raise RuntimeError("Gateway database role or schema version is unsafe.")

    async def close(self) -> None:
        await self.engine.dispose()


async def lock_tenant(connection: AsyncConnection, tenant: UUID, *, exclusive: bool = False) -> None:
    function = "pg_advisory_xact_lock" if exclusive else "pg_advisory_xact_lock_shared"
    await connection.execute(
        text(f"SELECT {function}(hashtextextended(:tenant, 0))"), {"tenant": f"aegis-tenant:{tenant}"}
    )


async def lock_catalog(connection: AsyncConnection, *, exclusive: bool = False) -> None:
    function = "pg_advisory_xact_lock" if exclusive else "pg_advisory_xact_lock_shared"
    await connection.execute(text(f"SELECT {function}(:lock)"), {"lock": CATALOG_LOCK})
