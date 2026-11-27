import { randomUUID } from "node:crypto";
import { currentUtcWindow } from "./ledger.js";

const integer = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Database returned a value outside the safe integer range.");
  return number;
};
const iso = value => new Date(value).toISOString();
const json = value => typeof value === "string" ? JSON.parse(value) : value;

function mapBudget(row) {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    window_start: iso(row.window_start),
    window_end: iso(row.window_end),
    limit_uusd: integer(row.limit_uusd),
    settled_uusd: integer(row.settled_uusd),
    reserved_uusd: integer(row.reserved_uusd)
  };
}

function mapUsage(row) {
  if (!row) return null;
  return {
    request_id: row.request_id,
    tenant_id: row.tenant_id,
    window_start: iso(row.window_start),
    model: row.model,
    route: json(row.route),
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    cost_uusd: integer(row.cost_uusd),
    created_at: iso(row.created_at),
    status: row.status
  };
}

export class PostgresLedger {
  constructor({ pool, clock = () => new Date() } = {}) {
    if (!pool) throw new Error("PostgresLedger requires a node-postgres Pool.");
    this.pool = pool;
    this.clock = clock;
    this.storageMode = "postgres";
  }

  async #ensureWindow(client, tenantId) {
    const window = currentUtcWindow(this.clock());
    await client.query(
      `INSERT INTO budget_windows (tenant_id, window_start, window_end, limit_uusd)
       SELECT tenant_id, $2, $3, monthly_limit_uusd FROM tenants
       WHERE tenant_id = $1 AND active = TRUE
       ON CONFLICT (tenant_id, window_start) DO NOTHING`,
      [tenantId, window.window_start, window.window_end]
    );
    const result = await client.query(
      `SELECT tenant_id, window_start, window_end, limit_uusd, settled_uusd, reserved_uusd
       FROM budget_windows WHERE tenant_id = $1 AND window_start = $2`,
      [tenantId, window.window_start]
    );
    return result.rows[0] ?? null;
  }

  async getTenant(tenantId) {
    const result = await this.pool.query(
      "SELECT tenant_id, name FROM tenants WHERE tenant_id = $1 AND active = TRUE",
      [tenantId]
    );
    const row = result.rows[0];
    return row ? { id: row.tenant_id, name: row.name } : null;
  }

  async getBudget(tenantId) {
    const client = await this.pool.connect();
    try { return mapBudget(await this.#ensureWindow(client, tenantId)); }
    finally { client.release(); }
  }

  async getOverview(tenantId) {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) return null;
    const budget = await this.getBudget(tenantId);
    if (!budget) return null;
    const result = await this.pool.query(
      `SELECT request_id, tenant_id, window_start, model, route, input_tokens, output_tokens,
              total_tokens, cost_uusd, status, created_at
       FROM usage_entries
       WHERE tenant_id = $1 AND window_start = $2
       ORDER BY created_at DESC, usage_id DESC`,
      [tenantId, budget.window_start]
    );
    return { tenant, budget, entries: result.rows.map(mapUsage) };
  }

  async beginRequest({ tenantId, idempotencyKey, requestHash }) {
    const client = await this.pool.connect();
    const requestId = `req_${randomUUID()}`;
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO idempotency_records (tenant_id, idempotency_key, request_hash, request_id, state)
         VALUES ($1, $2, $3, $4, 'in_progress')
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING request_id`,
        [tenantId, idempotencyKey, requestHash, requestId]
      );
      if (inserted.rowCount === 1) {
        await client.query("COMMIT");
        return { kind: "new", requestId, key: { tenantId, idempotencyKey } };
      }
      const existingResult = await client.query(
        `SELECT request_hash, request_id, state, response_status, response_body
         FROM idempotency_records
         WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [tenantId, idempotencyKey]
      );
      const existing = existingResult.rows[0];
      await client.query("COMMIT");
      if (!existing) throw new Error("Idempotency record disappeared during conflict resolution.");
      if (existing.request_hash !== requestHash) return { kind: "conflict", requestId: existing.request_id };
      if (existing.state === "in_progress") return { kind: "in_progress", requestId: existing.request_id };
      return {
        kind: "replay",
        requestId: existing.request_id,
        status: existing.response_status,
        body: json(existing.response_body)
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async completeRequest(key, { status, body }) {
    const tenantId = typeof key === "object" ? key.tenantId : null;
    const idempotencyKey = typeof key === "object" ? key.idempotencyKey : null;
    if (!tenantId || !idempotencyKey) throw new Error("PostgreSQL idempotency completion requires a tenant-scoped key.");
    const result = await this.pool.query(
      `UPDATE idempotency_records
       SET state = 'complete', response_status = $3, response_body = $4::jsonb, completed_at = now()
       WHERE tenant_id = $1 AND idempotency_key = $2 AND state = 'in_progress'`,
      [tenantId, idempotencyKey, status, JSON.stringify(body)]
    );
    if (result.rowCount !== 1) throw new Error("Active idempotency record not found.");
  }

  async reserve({ tenantId, requestId, quoteUusd }) {
    if (!Number.isSafeInteger(quoteUusd) || quoteUusd < 0) throw new Error("Reservation amount must be a non-negative safe integer.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const created = await this.#ensureWindow(client, tenantId);
      if (!created) throw new Error("Tenant not found or inactive.");
      const locked = await client.query(
        `SELECT tenant_id, window_start, window_end, limit_uusd, settled_uusd, reserved_uusd
         FROM budget_windows WHERE tenant_id = $1 AND window_start = $2 FOR UPDATE`,
        [tenantId, created.window_start]
      );
      const row = locked.rows[0];
      if (!row) throw new Error("Current budget window could not be locked.");
      const budget = mapBudget(row);
      const remaining = budget.limit_uusd - budget.settled_uusd - budget.reserved_uusd;
      if (quoteUusd > remaining) {
        await client.query("COMMIT");
        return { admitted: false, remaining_uusd: remaining, budget };
      }
      const reservationId = `res_${randomUUID()}`;
      await client.query(
        `INSERT INTO reservations (reservation_id, request_id, tenant_id, window_start, quote_uusd, state)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [reservationId, requestId, tenantId, budget.window_start, quoteUusd]
      );
      const updated = await client.query(
        `UPDATE budget_windows SET reserved_uusd = reserved_uusd + $3
         WHERE tenant_id = $1 AND window_start = $2
         RETURNING tenant_id, window_start, window_end, limit_uusd, settled_uusd, reserved_uusd`,
        [tenantId, budget.window_start, quoteUusd]
      );
      await client.query("COMMIT");
      return {
        admitted: true,
        remaining_uusd: remaining - quoteUusd,
        budget: mapBudget(updated.rows[0]),
        reservation: {
          reservation_id: reservationId,
          request_id: requestId,
          tenant_id: tenantId,
          window_start: budget.window_start,
          quote_uusd: quoteUusd,
          state: "active",
          created_at: this.clock().toISOString()
        }
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async markReconcileRequired(reservationId) {
    await this.pool.query(
      `UPDATE reservations SET state = 'reconcile_required'
       WHERE reservation_id = $1 AND state = 'active'`,
      [reservationId]
    );
    const result = await this.pool.query("SELECT * FROM reservations WHERE reservation_id = $1", [reservationId]);
    const row = result.rows[0];
    if (!row) throw new Error("Reservation not found.");
    return {
      reservation_id: row.reservation_id,
      request_id: row.request_id,
      tenant_id: row.tenant_id,
      window_start: iso(row.window_start),
      quote_uusd: integer(row.quote_uusd),
      state: row.state,
      created_at: iso(row.created_at),
      ...(row.settled_at ? { settled_at: iso(row.settled_at) } : {})
    };
  }

  async settle({ reservationId, usage }) {
    if (!Number.isSafeInteger(usage.cost_uusd) || usage.cost_uusd < 0) throw new Error("Actual usage cost must be a non-negative safe integer.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reservationResult = await client.query(
        "SELECT * FROM reservations WHERE reservation_id = $1 FOR UPDATE",
        [reservationId]
      );
      const reservation = reservationResult.rows[0];
      if (!reservation) throw new Error("Reservation not found.");
      if (reservation.state === "settled") {
        const existing = await client.query("SELECT * FROM usage_entries WHERE reservation_id = $1", [reservationId]);
        await client.query("COMMIT");
        return { entry: mapUsage(existing.rows[0]), duplicate: true };
      }
      if (reservation.state !== "active" && reservation.state !== "reconcile_required") {
        throw new Error(`Cannot settle reservation in state ${reservation.state}.`);
      }
      const quote = integer(reservation.quote_uusd);
      if (usage.cost_uusd > quote) throw new Error("Actual usage must not exceed its reservation.");
      await client.query(
        `UPDATE budget_windows
         SET reserved_uusd = reserved_uusd - $3, settled_uusd = settled_uusd + $4
         WHERE tenant_id = $1 AND window_start = $2`,
        [reservation.tenant_id, reservation.window_start, quote, usage.cost_uusd]
      );
      await client.query(
        `UPDATE reservations SET state = 'settled', settled_at = now()
         WHERE reservation_id = $1`,
        [reservationId]
      );
      const inserted = await client.query(
        `INSERT INTO usage_entries
          (reservation_id, request_id, tenant_id, window_start, model, route, input_tokens,
           output_tokens, total_tokens, cost_uusd, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
         RETURNING request_id, tenant_id, window_start, model, route, input_tokens, output_tokens,
                   total_tokens, cost_uusd, status, created_at`,
        [reservationId, reservation.request_id, reservation.tenant_id, reservation.window_start,
          usage.model, JSON.stringify(usage.route), usage.input_tokens, usage.output_tokens,
          usage.input_tokens + usage.output_tokens, usage.cost_uusd, usage.status ?? "completed"]
      );
      await client.query("COMMIT");
      return { entry: mapUsage(inserted.rows[0]), duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async getReservation(reservationId) {
    const result = await this.pool.query("SELECT * FROM reservations WHERE reservation_id = $1", [reservationId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      reservation_id: row.reservation_id,
      request_id: row.request_id,
      tenant_id: row.tenant_id,
      window_start: iso(row.window_start),
      quote_uusd: integer(row.quote_uusd),
      state: row.state,
      created_at: iso(row.created_at),
      ...(row.settled_at ? { settled_at: iso(row.settled_at) } : {})
    };
  }

  async getUsageCount(tenantId) {
    const result = await this.pool.query("SELECT count(*) AS count FROM usage_entries WHERE tenant_id = $1", [tenantId]);
    return integer(result.rows[0].count);
  }

  async seedTenant({ id, name, limit_uusd, seeded_settled_uusd = 0 }) {
    if (![limit_uusd, seeded_settled_uusd].every(Number.isSafeInteger) || limit_uusd < 0 || seeded_settled_uusd < 0 || seeded_settled_uusd > limit_uusd) {
      throw new Error("Tenant limits and seeded spend must be valid non-negative safe integers.");
    }
    const client = await this.pool.connect();
    const window = currentUtcWindow(this.clock());
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tenants (tenant_id, name, monthly_limit_uusd)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET name = EXCLUDED.name, monthly_limit_uusd = EXCLUDED.monthly_limit_uusd`,
        [id, name, limit_uusd]
      );
      await client.query(
        `INSERT INTO budget_windows (tenant_id, window_start, window_end, limit_uusd, settled_uusd)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, window_start) DO NOTHING`,
        [id, window.window_start, window.window_end, limit_uusd, seeded_settled_uusd]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}
