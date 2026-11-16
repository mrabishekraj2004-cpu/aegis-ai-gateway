FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

FROM base AS build
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY backend/requirements.lock .
RUN pip install --require-hashes -r requirements.lock
COPY backend/ .
RUN pip install --no-deps .

FROM build AS tests
COPY backend/requirements-test.lock .
RUN pip install --require-hashes -r requirements-test.lock
CMD ["pytest", "-q", "tests"]

FROM base AS runtime
RUN groupadd --system aegis && useradd --system --gid aegis --no-create-home aegis
COPY --from=build /opt/venv /opt/venv
COPY backend/alembic.ini .
COPY backend/migrations ./migrations
ENV PATH="/opt/venv/bin:$PATH"
USER aegis
EXPOSE 8080
CMD ["uvicorn", "aegis.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-access-log", "--no-proxy-headers", "--timeout-graceful-shutdown", "95"]
