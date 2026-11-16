import base64
import hashlib
import hmac
import json
from calendar import monthrange
from datetime import UTC, date, datetime, timedelta
from time import time
from uuid import UUID

import sqlalchemy as sa
from pydantic import BaseModel, Field

from aegis import models as db
from aegis.database import Database
from aegis.errors import GatewayError

COUNT_FIELDS = (
    "requests",
    "attempts",
    "reported_attempts",
    "estimated_attempts",
    "adjusted_attempts",
    "confirmed_nonbillable_attempts",
    "pending_attempts",
    "prompt_tokens_observed",
    "completion_tokens_observed",
    "unknown_token_attempts",
    "reported_microusd",
    "estimated_microusd",
    "adjusted_microusd",
    "pending_hold_microusd",
    "total_finalized_microusd",
)


class UsageRow(BaseModel):
    day: date | None
    model: str | None
    requests: str
    attempts: str
    reported_attempts: str
    estimated_attempts: str
    adjusted_attempts: str
    confirmed_nonbillable_attempts: str
    pending_attempts: str
    prompt_tokens_observed: str
    completion_tokens_observed: str
    unknown_token_attempts: str
    reported_microusd: str
    estimated_microusd: str
    adjusted_microusd: str
    pending_hold_microusd: str
    total_finalized_microusd: str


class Page(BaseModel):
    object: str = "list"
    has_more: bool
    next_cursor: str | None


class UsagePage(Page):
    data: list[UsageRow]
    as_of: datetime
    complete_through: date | None
    currency: str = "USD"
    range: dict[str, date] = Field(description="UTC day range with exclusive to date")


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def unb64(raw: str) -> bytes:
    decoded = base64.b64decode(raw + "=" * (-len(raw) % 4), altchars=b"-_", validate=True)
    if b64(decoded) != raw:
        raise ValueError
    return decoded


class Cursors:
    def __init__(self, secret: str) -> None:
        self.key = secret.encode()

    def issue(self, tenant: UUID, route: str, filters: dict, snapshot: datetime, position: list[str]) -> str:
        data = {
            "v": 1,
            "tenant": str(tenant),
            "route": route,
            "filters": filters,
            "snapshot": snapshot.isoformat(),
            "position": position,
            "exp": int(snapshot.timestamp()) + 900,
        }
        raw = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
        return f"{b64(raw)}.{b64(hmac.digest(self.key, raw, hashlib.sha256))}"

    def read(self, token: str, tenant: UUID, route: str, filters: dict) -> tuple[datetime, list[str]]:
        try:
            if len(token) > 2048:
                raise ValueError
            raw, sig = (unb64(item) for item in token.split("."))
            if not hmac.compare_digest(sig, hmac.digest(self.key, raw, hashlib.sha256)):
                raise ValueError
            data = json.loads(raw)
            if (
                data["v"] != 1
                or data["tenant"] != str(tenant)
                or data["route"] != route
                or data["filters"] != filters
            ):
                raise ValueError
            if time() >= data["exp"]:
                raise GatewayError(410, "cursor_expired", "The cursor has expired.")
            return datetime.fromisoformat(data["snapshot"]), data["position"]
        except (ValueError, KeyError, TypeError, UnicodeError, OverflowError):
            raise GatewayError(
                400, "invalid_cursor", "The cursor does not match the requested page."
            ) from None


def thirteen_months_ago(today: date) -> date:
    index = today.year * 12 + today.month - 1 - 13
    year, month = divmod(index, 12)
    return date(year, month + 1, min(today.day, monthrange(year, month + 1)[1]))


def day_range(start: str | None, stop: str | None, today: date) -> tuple[date, date]:
    try:
        begin, end = date.fromisoformat(start or ""), date.fromisoformat(stop or "")
        if (
            begin.isoformat() != start
            or end.isoformat() != stop
            or not begin < end
            or (end - begin).days > 93
            or begin < thirteen_months_ago(today)
            or end > today + timedelta(days=1)
        ):
            raise ValueError
        return begin, end
    except ValueError:
        raise GatewayError(
            400, "invalid_request", "Provide a retained UTC date range of 1 to 93 days."
        ) from None


async def usage_report(
    database: Database,
    tenant: UUID,
    start: date,
    end: date,
    model: str | None,
    group: str,
    limit: int,
    snapshot: datetime,
    position: tuple[date | None, str | None] | None,
) -> list[dict]:
    r, a, u = db.requests.c, db.attempts.c, db.usage.c
    request_date = sa.cast(sa.func.timezone("UTC", r.received_at), sa.Date)
    first, last = [datetime.combine(value, datetime.min.time(), UTC) for value in (start, end)]
    by_day, by_alias = group != "model", group != "day"
    day = request_date if by_day else sa.cast(sa.null(), sa.Date)
    alias = db.aliases.c.code if by_alias else sa.cast(sa.null(), sa.Text)
    pending = a.state.in_(("authorized", "pending"))
    counts = {
        "requests": sa.func.count(sa.distinct(r.id)),
        "attempts": sa.func.count(a.id),
        "reported_attempts": sa.func.count(a.id).filter(a.state == "reported"),
        "estimated_attempts": sa.func.count(a.id).filter(a.state == "estimated"),
        "adjusted_attempts": sa.func.count(a.id).filter(a.state == "adjusted"),
        "confirmed_nonbillable_attempts": sa.func.count(a.id).filter(a.state == "confirmed_nonbillable"),
        "pending_attempts": sa.func.count(a.id).filter(pending),
        "prompt_tokens_observed": sa.func.coalesce(sa.func.sum(u.prompt_tokens), 0),
        "completion_tokens_observed": sa.func.coalesce(sa.func.sum(u.completion_tokens), 0),
        "unknown_token_attempts": sa.func.count(a.id).filter(
            sa.or_(u.prompt_tokens.is_(None), u.completion_tokens.is_(None))
        ),
        "reported_microusd": sa.func.coalesce(sa.func.sum(a.charged).filter(a.state == "reported"), 0),
        "estimated_microusd": sa.func.coalesce(sa.func.sum(a.charged).filter(a.state == "estimated"), 0),
        "adjusted_microusd": sa.func.coalesce(sa.func.sum(a.charged).filter(a.state == "adjusted"), 0),
        "pending_hold_microusd": sa.func.coalesce(sa.func.sum(a.hold).filter(pending), 0),
        "total_finalized_microusd": sa.func.coalesce(sa.func.sum(a.charged), 0),
    }
    stmt = (
        sa.select(
            day.label("day"), alias.label("model"), *(value.label(key) for key, value in counts.items())
        )
        .select_from(
            db.requests.join(db.aliases, r.alias_id == db.aliases.c.id)
            .outerjoin(db.attempts, sa.and_(r.tenant_id == a.tenant_id, r.id == a.request_id))
            .outerjoin(db.usage, sa.and_(a.tenant_id == u.tenant_id, a.id == u.attempt_id))
        )
        .where(r.tenant_id == tenant, r.received_at >= first, r.received_at < last, r.received_at <= snapshot)
    )
    if model:
        stmt = stmt.where(db.aliases.c.code == model)
    # At least one dimension is always present. Empty ranges never yield an artificial null row.
    order = []
    groups = []
    if by_day:
        order.append(day.desc())
        groups.append(day)
    if by_alias:
        order.append(alias.asc())
        groups.append(alias)
    if position:
        day_pos, model_pos = position
        if by_day and by_alias:
            stmt = stmt.where(sa.or_(day < day_pos, sa.and_(day == day_pos, alias > model_pos)))
        elif by_day:
            stmt = stmt.where(day < day_pos)
        else:
            stmt = stmt.where(alias > model_pos)
    stmt = stmt.group_by(*groups).order_by(*order).limit(limit + 1)
    async with database.transaction(tenant) as conn:
        if model:
            known = await conn.scalar(
                sa.select(db.routing_policies.c.id)
                .join(db.aliases, db.routing_policies.c.alias_id == db.aliases.c.id)
                .where(db.routing_policies.c.tenant_id == tenant, db.aliases.c.code == model)
            )
            if not known:
                raise GatewayError(404, "model_not_found", "The requested model alias is unavailable.")
        rows = (await conn.execute(stmt)).mappings().all()
    return [
        {"day": row["day"], "model": row["model"], **{key: str(row[key]) for key in COUNT_FIELDS}}
        for row in rows
    ]
