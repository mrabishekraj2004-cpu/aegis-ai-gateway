import os

from alembic import context
from sqlalchemy import create_engine, pool, text

from aegis.models import m

LOCK_ID = 3820538496


def run() -> None:
    if context.is_offline_mode():
        context.configure(dialect_name="postgresql", target_metadata=m, literal_binds=True)
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = create_engine(
        os.environ["AEGIS_MIGRATION_DATABASE_URL"], poolclass=pool.NullPool, hide_parameters=True
    )
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT pg_advisory_lock(:id)"), {"id": LOCK_ID})
            connection.execute(text("SET lock_timeout = '5s'"))
            connection.execute(text("SET statement_timeout = '60s'"))
            connection.commit()
            try:
                context.configure(connection=connection, target_metadata=m, include_schemas=True)
                with context.begin_transaction():
                    context.run_migrations()
            finally:
                connection.rollback()
                connection.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": LOCK_ID})
    finally:
        engine.dispose()


run()
