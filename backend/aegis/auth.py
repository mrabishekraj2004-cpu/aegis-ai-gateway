import asyncio
import base64
import hashlib
import hmac
import json
import re
import secrets
from time import monotonic
from uuid import UUID

import httpx
import jwt
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection
from starlette.datastructures import Headers

from aegis import models as db
from aegis.contracts import Principal
from aegis.database import Database
from aegis.errors import GatewayError
from aegis.settings import Settings

KEY_SCOPES = frozenset({"chat:write", "models:read", "usage:read"})
KEY_PATTERN = re.compile(r"ag_(live|test)_([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})\Z")


def key_prefix(settings: Settings) -> str:
    return "live" if settings.environment in {"staging", "production"} else "test"


def digest(settings: Settings, public_id: str, secret: bytes, version: str) -> bytes:
    pepper = settings.key_peppers[version].get_secret_value().encode()
    context = f"aegis-key-v1\0{settings.environment}\0{public_id}\0".encode()
    return hmac.digest(pepper, context + secret, "sha256")


def new_key(settings: Settings) -> tuple[str, str, bytes]:
    public_id = secrets.token_urlsafe(12)
    secret = secrets.token_bytes(32)
    encoded = base64.urlsafe_b64encode(secret).decode().rstrip("=")
    return (
        f"ag_{key_prefix(settings)}_{public_id}.{encoded}",
        public_id,
        digest(settings, public_id, secret, settings.active_pepper),
    )


def require(principal: Principal, scope: str) -> None:
    if scope not in principal.scopes:
        raise GatewayError(403, "insufficient_scope", "The credential lacks the required permission.")


class Auth:
    def __init__(self, settings: Settings, database: Database, client: httpx.AsyncClient) -> None:
        self.settings, self.database, self.client = settings, database, client
        self.jwks: dict[str, jwt.PyJWK] = {}
        self.cached_at = float("-inf")
        self.last_refresh = float("-inf")
        self.refresh_lock = asyncio.Lock()

    async def principal(self, headers: Headers, *, users_only: bool = False) -> Principal:
        values = headers.getlist("authorization")
        if not values:
            raise GatewayError(401, "authentication_required", "A bearer credential is required.")
        if len(values) != 1 or len(values[0]) > 8192:
            raise GatewayError(401, "invalid_access_token", "Invalid bearer credential.")
        scheme, _, token = values[0].partition(" ")
        if scheme.lower() != "bearer" or not token or any(char.isspace() for char in token):
            raise GatewayError(401, "invalid_access_token", "Invalid bearer credential.")
        tenant_headers = headers.getlist("x-tenant-id")
        tenant = None
        if tenant_headers:
            try:
                [value] = tenant_headers
                tenant = UUID(value)
                if str(tenant) != value:
                    raise ValueError
            except ValueError:
                raise GatewayError(403, "tenant_forbidden", "Invalid tenant context.") from None
        if token.startswith("ag_"):
            principal = await self.api_key(token)
            if users_only:
                raise GatewayError(403, "insufficient_scope", "A dashboard identity is required.")
            if tenant and tenant != principal.tenant_id:
                raise GatewayError(403, "tenant_forbidden", "The credential is scoped to another tenant.")
            return principal
        claims = await self.access_token(token)
        if not tenant:
            raise GatewayError(403, "tenant_forbidden", "A verified tenant context is required.")
        async with self.database.transaction(tenant) as conn:
            user = await conn.scalar(
                sa.select(db.users.c.id).where(
                    db.users.c.issuer == claims["iss"],
                    db.users.c.subject == claims["sub"],
                )
            )
            scopes = await membership_scopes(conn, tenant, user) if user else None
        if scopes is None:
            raise GatewayError(403, "tenant_forbidden", "The identity has no active tenant membership.")
        return Principal(tenant, user, "user", scopes)

    async def api_key(self, token: str) -> Principal:
        invalid = GatewayError(401, "invalid_api_key", "The API key is invalid or inactive.")
        match = KEY_PATTERN.fullmatch(token)
        if match is None or match[1] != key_prefix(self.settings):
            raise invalid
        _, lookup_id, encoded = match.groups()
        raw = base64.urlsafe_b64decode(encoded + "=")
        if base64.urlsafe_b64encode(raw).decode().rstrip("=") != encoded:
            raise invalid
        async with self.database.transaction() as conn:
            row = (
                (
                    await conn.execute(
                        sa.text("SELECT * FROM aegis.lookup_api_key(:lookup)"), {"lookup": lookup_id}
                    )
                )
                .mappings()
                .one_or_none()
            )
        version = row["pepper_version"] if row else ""
        recognized = version in self.settings.key_peppers
        expected = row["digest"] if row and recognized else hashlib.sha256(b"aegis-unknown-key").digest()
        computed = digest(
            self.settings, lookup_id, raw, version if recognized else self.settings.active_pepper
        )
        if not hmac.compare_digest(expected, computed) or not row or not recognized:
            raise invalid
        return Principal(row["tenant_id"], row["actor_id"], "key", frozenset(row["scopes"]), lookup_id)

    async def access_token(self, token: str) -> dict:
        invalid = GatewayError(401, "invalid_access_token", "The access token is invalid or expired.")
        if not self.settings.oidc_jwks_url:
            raise invalid
        try:
            header = jwt.get_unverified_header(token)
            kid = header.get("kid")
            if (
                header.get("alg") != "RS256"
                or not isinstance(kid, str)
                or not 1 <= len(kid) <= 128
                or header.get("crit")
                or header.get("jku")
                or header.get("jwk")
            ):
                raise invalid
            key = await self.signing_key(kid)
            if key is None:
                raise invalid
            claims = jwt.decode(
                token,
                key=key.key,
                algorithms=["RS256"],
                issuer=self.settings.oidc_issuer,
                audience=self.settings.oidc_audience,
                options={"require": ["iss", "aud", "exp", "iat", "sub"]},
                leeway=15,
            )
            if (
                header.get("typ", "").lower() not in {"at+jwt", "application/at+jwt"}
                and claims.get("token_use") != "access"
            ):
                raise invalid
            if (
                not isinstance(claims["sub"], str)
                or not 1 <= len(claims["sub"]) <= 255
                or type(claims["iat"]) is not int
                or type(claims["exp"]) is not int
                or not 0 < claims["exp"] - claims["iat"] <= 900
            ):
                raise invalid
            return claims
        except (jwt.PyJWTError, AttributeError, TypeError, ValueError, OverflowError):
            raise invalid from None

    async def signing_key(self, kid: str) -> jwt.PyJWK | None:
        now = monotonic()
        if kid in self.jwks and now - self.cached_at < 300:
            return self.jwks[kid]
        async with self.refresh_lock:
            now = monotonic()
            age = now - self.cached_at
            if age < 300 and kid in self.jwks:
                return self.jwks[kid]
            if now - self.last_refresh < 10:
                return None
            # Rate-limit refresh attempts independently of the last valid key set.
            self.last_refresh = now
            try:
                async with (
                    asyncio.timeout(2),
                    self.client.stream("GET", self.settings.oidc_jwks_url) as response,
                ):
                    if response.status_code != 200:
                        raise ValueError
                    payload = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(payload) + len(chunk) > 65536:
                            raise ValueError
                        payload.extend(chunk)
                keys = json.loads(payload)["keys"]
                if not isinstance(keys, list) or len(keys) > 32:
                    raise ValueError
                result = {}
                for item in keys:
                    if (
                        item.get("kty") == "RSA"
                        and item.get("alg", "RS256") == "RS256"
                        and item.get("use", "sig") == "sig"
                        and isinstance(item.get("kid"), str)
                    ):
                        if item["kid"] in result:
                            raise ValueError
                        result[item["kid"]] = jwt.PyJWK.from_dict(item, algorithm="RS256")
                self.jwks = result
                self.cached_at = now
            except (
                httpx.HTTPError,
                TimeoutError,
                ValueError,
                KeyError,
                TypeError,
                AttributeError,
                jwt.PyJWTError,
            ):
                return None
            return self.jwks.get(kid)


async def membership_scopes(
    conn: AsyncConnection,
    tenant: UUID,
    user: UUID,
) -> frozenset[str] | None:
    role = await conn.scalar(
        sa.select(db.memberships.c.role)
        .join(db.tenants, db.tenants.c.id == db.memberships.c.tenant_id)
        .where(
            db.memberships.c.tenant_id == tenant,
            db.memberships.c.user_id == user,
            db.memberships.c.active,
            db.tenants.c.active,
        )
    )
    if role is None:
        return None
    rows = await conn.scalars(
        sa.select(db.role_permissions.c.permission).where(db.role_permissions.c.role == role)
    )
    return frozenset(rows)


async def still_authorized(conn: AsyncConnection, principal: Principal, action: str) -> bool:
    if principal.kind == "user":
        scopes = await membership_scopes(conn, principal.tenant_id, principal.actor_id)
        return scopes is not None and action in scopes
    active = await conn.scalar(
        sa.select(sa.literal(True))
        .select_from(
            db.api_keys.join(db.tenants, db.tenants.c.id == db.api_keys.c.tenant_id).join(
                db.api_key_scopes,
                sa.and_(
                    db.api_key_scopes.c.tenant_id == db.api_keys.c.tenant_id,
                    db.api_key_scopes.c.key_id == db.api_keys.c.id,
                ),
            )
        )
        .where(
            db.api_keys.c.tenant_id == principal.tenant_id,
            db.api_keys.c.id == principal.actor_id,
            db.api_keys.c.revoked_at.is_(None),
            db.api_keys.c.expires_at > sa.func.clock_timestamp(),
            db.tenants.c.active,
            db.api_key_scopes.c.scope == action,
        )
    )
    return bool(active)
