from typing import Literal
from urllib.parse import parse_qs, urlsplit

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class RuntimeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AEGIS_", extra="ignore", env_ignore_empty=True)

    environment: Literal["local", "test", "staging", "production"] = "local"
    database_url: SecretStr
    trace_endpoint: str | None = None
    trace_sample_rate: float = Field(default=0.05, ge=0, le=1)
    db_pool_size: int = Field(default=10, ge=1, le=50)

    @model_validator(mode="after")
    def check_database(self) -> "RuntimeSettings":
        from sqlalchemy.engine import make_url

        value = self.database_url.get_secret_value()
        if not value.startswith("postgresql+psycopg://"):
            raise ValueError("use a PostgreSQL SQLAlchemy psycopg URL")
        if (
            self.environment in {"staging", "production"}
            and make_url(value).query.get("sslmode") != "verify-full"
        ):
            raise ValueError("managed environments require PostgreSQL sslmode=verify-full")
        return self


class Settings(RuntimeSettings):
    redis_url: SecretStr
    key_peppers: dict[str, SecretStr] = Field(min_length=1)
    active_pepper: str = "v1"
    cursor_secret: SecretStr
    metrics_token: SecretStr | None = None
    provider_credentials: dict[str, SecretStr] = Field(default_factory=dict)
    oidc_issuer: str | None = None
    oidc_audience: str | None = None
    oidc_jwks_url: str | None = None
    allowed_origins: list[str] = Field(default_factory=list)
    json_deadline: float = Field(default=35, gt=1, le=35)
    stream_deadline: float = Field(default=90, gt=1, le=90)
    json_upstream_deadline: float = Field(default=30, gt=0, le=30)
    stream_first_deadline: float = Field(default=10, gt=0, le=10)
    stream_idle_deadline: float = Field(default=15, gt=0, le=15)
    retry_limit: int = Field(default=2, ge=1, le=2)
    tenant_inflight: int = Field(default=16, ge=1, le=1000)
    deployment_inflight: int = Field(default=64, ge=1, le=1000)
    process_inflight: int = Field(default=128, ge=1, le=1000)
    retry_per_minute: int = Field(default=6, ge=1, le=1000)
    breaker_cold_seconds: int = Field(default=10, ge=0, le=10)

    @model_validator(mode="after")
    def check_dependencies(self) -> "Settings":
        if self.active_pepper not in self.key_peppers:
            raise ValueError("active key pepper version is unavailable")
        secrets = [self.cursor_secret, *self.key_peppers.values()]
        if self.metrics_token is not None:
            secrets.append(self.metrics_token)
        if any(len(item.get_secret_value().encode()) < 32 for item in secrets):
            raise ValueError("key peppers, cursor and metric secrets require at least 32 bytes")
        if len({item.get_secret_value() for item in secrets}) != len(secrets):
            raise ValueError("cursor, metrics and pepper secrets must be distinct")
        redis_location = urlsplit(self.redis_url.get_secret_value())
        redis_scheme = redis_location.scheme
        if redis_scheme not in {"redis", "rediss", "unix"}:
            raise ValueError("invalid Redis connection scheme")
        options = parse_qs(redis_location.query, keep_blank_values=True)
        allowed_options = {"db"}
        if redis_scheme == "rediss":
            allowed_options.update(
                {
                    "ssl_ca_certs",
                    "ssl_certfile",
                    "ssl_keyfile",
                    "ssl_cert_reqs",
                    "ssl_check_hostname",
                }
            )
            if options.get("ssl_cert_reqs", ["required"]) != ["required"] or options.get(
                "ssl_check_hostname", ["true"]
            ) != ["true"]:
                raise ValueError("Redis TLS requires certificate and hostname verification")
        if set(options) - allowed_options:
            raise ValueError("Redis URL cannot override bounded network and retry settings")
        if self.environment in {"staging", "production"} and redis_scheme != "rediss":
            raise ValueError("managed environments require TLS Redis")
        if self.environment in {"staging", "production"} and self.breaker_cold_seconds != 10:
            raise ValueError("managed environments require breaker cold quarantine")
        oidc = (self.oidc_issuer, self.oidc_audience, self.oidc_jwks_url)
        if any(oidc) and not all(oidc):
            raise ValueError("configure all OIDC settings together")
        for endpoint in (self.oidc_issuer, self.oidc_jwks_url):
            if endpoint and (urlsplit(endpoint).scheme != "https" or not urlsplit(endpoint).hostname):
                raise ValueError("OIDC endpoints require named HTTPS hosts")
        if any(
            urlsplit(origin).scheme not in {"https", "http"}
            or not urlsplit(origin).hostname
            or urlsplit(origin).path
            or urlsplit(origin).query
            or urlsplit(origin).fragment
            or urlsplit(origin).username
            or "*" in origin
            for origin in self.allowed_origins
        ):
            raise ValueError("CORS requires exact origins")
        if self.environment in {"staging", "production"} and any(
            not origin.startswith("https://") for origin in self.allowed_origins
        ):
            raise ValueError("managed environments require HTTPS browser origins")
        return self
