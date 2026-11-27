import { randomUUID } from "node:crypto";
import { currentUtcWindow } from "./ledger.js";
import { PostgresControlPlane } from "./control-plane.js";

const integer = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Database returned a value outside the safe integer range.");
  return number;
};
const iso = value => new Date(value).toISOString();
const json = value => typeof value === "string" ? JSON.parse(value) : value;

function quotaWindow(period, now) {
  const date = new Date(now);
  const start = period === "day" ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = period === "day" ? new Date(start.getTime() + 86_400_000) : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

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

export class PostgresLedger extends PostgresControlPlane {
  constructor({ pool, clock = () => new Date() } = {}) {
    if (!pool) throw new Error("PostgresLedger requires a node-postgres Pool.");
    super({ pool, clock });
    this.storageMode = "postgres";
  }

  async #ledgerEvent(client, { tenantId, requestId = null, reservationId = null, windowStart = null, type, amount = 0, reservedDelta = 0, tokens = 0, pricingVersion = null, configVersion = null, idempotencyKey, payload = {} }) {
    const inserted = await client.query(
      `INSERT INTO ledger_events (tenant_id,request_id,reservation_id,window_start,event_type,amount_delta_uusd,reserved_delta_uusd,token_delta,pricing_version,config_version,idempotency_key,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING event_id`,
      [tenantId,requestId,reservationId,windowStart,type,amount,reservedDelta,tokens,pricingVersion,configVersion,idempotencyKey,JSON.stringify(payload)]
    );
    if (!inserted.rowCount) return null;
    const eventId = inserted.rows[0].event_id;
    await client.query(
      `INSERT INTO billing_outbox (event_id,event_key,payload) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (event_key) DO NOTHING`,
      [eventId,idempotencyKey,JSON.stringify({ event_id:eventId,tenant_id:tenantId,request_id:requestId,reservation_id:reservationId,type,amount_delta_uusd:amount,reserved_delta_uusd:reservedDelta,token_delta:tokens,payload })]
    );
    return eventId;
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
    try {
      const row = await this.#ensureWindow(client, tenantId);
      if (!row) return null;
      const projection = await client.query(
        `SELECT COALESCE(sum(amount_delta_uusd),0) AS settled_uusd,COALESCE(sum(reserved_delta_uusd),0) AS reserved_uusd
         FROM ledger_events WHERE tenant_id=$1 AND window_start=$2`, [tenantId,row.window_start]
      );
      return { ...mapBudget(row), settled_uusd:integer(projection.rows[0].settled_uusd), reserved_uusd:integer(projection.rows[0].reserved_uusd) };
    }
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

  async reserve({ tenantId, requestId, quoteUusd, quoteTokens = 0, userId = null, keyId = null, route = null }) {
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
      const ledgerProjection = await client.query(
        `SELECT COALESCE(sum(amount_delta_uusd),0) AS settled_uusd,COALESCE(sum(reserved_delta_uusd),0) AS reserved_uusd
         FROM ledger_events WHERE tenant_id=$1 AND window_start=$2`, [tenantId,row.window_start]
      );
      const settledFromEvents = integer(ledgerProjection.rows[0].settled_uusd);
      const reservedFromEvents = integer(ledgerProjection.rows[0].reserved_uusd);
      if (settledFromEvents !== integer(row.settled_uusd) || reservedFromEvents !== integer(row.reserved_uusd)) {
        await client.query("UPDATE budget_windows SET settled_uusd=$3,reserved_uusd=$4 WHERE tenant_id=$1 AND window_start=$2", [tenantId,row.window_start,settledFromEvents,reservedFromEvents]);
      }
      const budget = { ...mapBudget(row), settled_uusd:settledFromEvents, reserved_uusd:reservedFromEvents };
      const remaining = budget.limit_uusd - budget.settled_uusd - budget.reserved_uusd;
      if (quoteUusd > remaining) {
        await client.query("COMMIT");
        return { admitted: false, remaining_uusd: remaining, budget };
      }
      const policies = await client.query(
        `SELECT * FROM quota_policies WHERE tenant_id=$1 AND active=TRUE
         AND (principal_id IS NULL OR principal_id=$2)
         AND (api_key_id IS NULL OR api_key_id=$3)
         ORDER BY quota_id FOR UPDATE`, [tenantId, userId, keyId]
      );
      const quotaLocks = [];
      for (const policy of policies.rows) {
        const window = quotaWindow(policy.period, this.clock());
        await client.query(
          `INSERT INTO quota_windows (quota_id,window_start,window_end) VALUES ($1,$2,$3)
           ON CONFLICT (quota_id,window_start) DO NOTHING`, [policy.quota_id, window.start, window.end]
        );
        const lockedQuota = await client.query(
          `SELECT * FROM quota_windows WHERE quota_id=$1 AND window_start=$2 FOR UPDATE`, [policy.quota_id, window.start]
        );
        const current = lockedQuota.rows[0];
        const exceeds =
          (policy.request_limit !== null && Number(current.request_count) + 1 > Number(policy.request_limit)) ||
          (policy.token_limit !== null && Number(current.token_count) + quoteTokens > Number(policy.token_limit)) ||
          (policy.cost_limit_uusd !== null && integer(current.cost_uusd) + quoteUusd > integer(policy.cost_limit_uusd)) ||
          (policy.concurrency_limit !== null && current.concurrency_count + 1 > policy.concurrency_limit);
        if (exceeds) {
          await client.query("COMMIT");
          return { admitted: false, reason: policy.concurrency_limit !== null && current.concurrency_count + 1 > policy.concurrency_limit ? "concurrency_limit" : "quota_exceeded", quota_id: policy.quota_id, period: policy.period, window_end: iso(current.window_end), retry_after:policy.concurrency_limit !== null && current.concurrency_count + 1 > policy.concurrency_limit ? 1 : null, budget };
        }
        quotaLocks.push({ policy, window });
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
      await client.query(
        `UPDATE reservations SET provider=$2,config_version=$3,pricing_version=$4 WHERE reservation_id=$1`,
        [reservationId, route?.provider ?? null, route?.config_version ?? null, route?.pricing_version ?? null]
      );
      await client.query(
        `INSERT INTO reconciliation_jobs (reservation_id,tenant_id,provider,state,next_attempt_at)
         VALUES ($1,$2,$3,'pending',now()+interval '2 minutes')`,
        [reservationId,tenantId,route?.provider ?? "unknown"]
      );
      for (const { policy, window } of quotaLocks) {
        await client.query(
          `UPDATE quota_windows SET request_count=request_count+1,token_count=token_count+$3,cost_uusd=cost_uusd+$4,concurrency_count=concurrency_count+1
           WHERE quota_id=$1 AND window_start=$2`, [policy.quota_id,window.start,quoteTokens,quoteUusd]
        );
        await client.query(
          `INSERT INTO quota_reservations (reservation_id,quota_id,window_start,quoted_tokens,quote_uusd)
           VALUES ($1,$2,$3,$4,$5)`, [reservationId,policy.quota_id,window.start,quoteTokens,quoteUusd]
        );
      }
      await this.#ledgerEvent(client, {
        tenantId,requestId,reservationId,windowStart:budget.window_start,type:"budget_reserved",reservedDelta:quoteUusd,tokens:quoteTokens,
        pricingVersion:route?.pricing_version ?? null,configVersion:route?.config_version ?? null,
        idempotencyKey:"budget_reserved:"+reservationId,payload:{quote_uusd:quoteUusd,route}
      });
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

  async markProviderStarted({ reservationId, provider, configVersion = null, pricingVersion = null, attempt = 1 }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE reservations SET state='provider_started',provider=$2,config_version=$3,pricing_version=$4,provider_attempts=GREATEST(provider_attempts,$5)
         WHERE reservation_id=$1 AND state IN ('active','provider_started') RETURNING tenant_id,request_id,window_start`,
        [reservationId,provider,configVersion,pricingVersion,attempt]
      );
      if (result.rows[0]) await this.#ledgerEvent(client, { tenantId:result.rows[0].tenant_id,requestId:result.rows[0].request_id,reservationId,windowStart:result.rows[0].window_start,type:"provider_started",idempotencyKey:"provider_started:"+reservationId+":"+attempt,payload:{provider,attempt} });
      await client.query("UPDATE reconciliation_jobs SET provider=$2 WHERE reservation_id=$1",[reservationId,provider]);
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async markProviderRequest(reservationId, providerRequestId) {
    await this.pool.query("UPDATE reservations SET provider_request_id=$2 WHERE reservation_id=$1", [reservationId,providerRequestId]);
    await this.pool.query("UPDATE reconciliation_jobs SET provider_request_id=$2 WHERE reservation_id=$1", [reservationId,providerRequestId]);
  }

  async markReconcileRequired(reservationId, { provider = null, providerRequestId = null } = {}) {
    const client = await this.pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      result = await client.query(
        `UPDATE reservations SET state='reconcile_required',provider=COALESCE($2,provider),provider_request_id=COALESCE($3,provider_request_id)
         WHERE reservation_id=$1 AND state IN ('active','provider_started') RETURNING tenant_id,request_id`, [reservationId,provider,providerRequestId]
      );
      const reservation = result.rows[0] ?? (await client.query("SELECT tenant_id,request_id FROM reservations WHERE reservation_id=$1", [reservationId])).rows[0];
      if (!reservation) throw new Error("Reservation not found.");
      await client.query(
        `UPDATE reconciliation_jobs SET state='retry',provider=COALESCE($2,provider),provider_request_id=COALESCE($3,provider_request_id),next_attempt_at=now(),last_error='provider outcome requires reconciliation'
         WHERE reservation_id=$1`, [reservationId,provider,providerRequestId]
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
    result = await this.pool.query("SELECT * FROM reservations WHERE reservation_id = $1", [reservationId]);
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
      if (!new Set(["active","provider_started","reconcile_required"]).has(reservation.state)) {
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
      const usageRow = inserted.rows[0];
      const quotaReservations = await client.query("SELECT * FROM quota_reservations WHERE reservation_id=$1 FOR UPDATE", [reservationId]);
      for (const quota of quotaReservations.rows) {
        await client.query(
          `UPDATE quota_windows SET token_count=GREATEST(0,token_count-$3+$4),cost_uusd=GREATEST(0,cost_uusd-$5+$6),concurrency_count=GREATEST(0,concurrency_count-1)
           WHERE quota_id=$1 AND window_start=$2`,
          [quota.quota_id,quota.window_start,quota.quoted_tokens,usage.input_tokens+usage.output_tokens,quota.quote_uusd,usage.cost_uusd]
        );
        await client.query("UPDATE quota_reservations SET settled_at=now() WHERE reservation_id=$1 AND quota_id=$2", [reservationId,quota.quota_id]);
      }
      await this.#ledgerEvent(client, {
        tenantId:reservation.tenant_id,requestId:reservation.request_id,reservationId,type:"usage_reported",
        windowStart:reservation.window_start,tokens:usage.input_tokens+usage.output_tokens,
        pricingVersion:usage.pricing_version ?? reservation.pricing_version,configVersion:usage.config_version ?? reservation.config_version,
        idempotencyKey:"usage_reported:"+reservationId,
        payload:{provider_cost_uusd:usage.provider_cost_uusd ?? null,calculated_cost_uusd:usage.cost_uusd,status:usage.status ?? "completed"}
      });
      await this.#ledgerEvent(client, {
        tenantId:reservation.tenant_id,requestId:reservation.request_id,reservationId,type:"settled",
        windowStart:reservation.window_start,amount:usage.cost_uusd,reservedDelta:-quote,tokens:usage.input_tokens+usage.output_tokens,
        pricingVersion:usage.pricing_version ?? reservation.pricing_version,configVersion:usage.config_version ?? reservation.config_version,
        idempotencyKey:"settled:"+reservationId,payload:{cost_uusd:usage.cost_uusd}
      });
      await client.query("UPDATE reconciliation_jobs SET state='settled',completed_at=now(),locked_at=NULL WHERE reservation_id=$1", [reservationId]);
      await client.query("COMMIT");
      return { entry: mapUsage(inserted.rows[0]), duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async releaseReservation({ reservationId, reason = "provider_not_started" }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT * FROM reservations WHERE reservation_id=$1 FOR UPDATE", [reservationId]);
      const reservation = locked.rows[0];
      if (!reservation) throw new Error("Reservation not found.");
      if (reservation.state === "released") { await client.query("COMMIT"); return { released:false,duplicate:true }; }
      if (reservation.state === "settled") throw new Error("A settled reservation cannot be released.");
      if (reservation.state === "provider_started" || reservation.state === "reconcile_required") throw new Error("A reservation with a potentially executed provider call requires reconciliation.");
      await client.query("UPDATE budget_windows SET reserved_uusd=reserved_uusd-$3 WHERE tenant_id=$1 AND window_start=$2", [reservation.tenant_id,reservation.window_start,reservation.quote_uusd]);
      await client.query("UPDATE reservations SET state='released',settled_at=now() WHERE reservation_id=$1", [reservationId]);
      await client.query("UPDATE reconciliation_jobs SET state='released',completed_at=now() WHERE reservation_id=$1", [reservationId]);
      const quotaReservations = await client.query("SELECT * FROM quota_reservations WHERE reservation_id=$1 AND settled_at IS NULL FOR UPDATE", [reservationId]);
      for (const quota of quotaReservations.rows) {
        await client.query(
          `UPDATE quota_windows SET token_count=GREATEST(0,token_count-$3),cost_uusd=GREATEST(0,cost_uusd-$4),concurrency_count=GREATEST(0,concurrency_count-1)
           WHERE quota_id=$1 AND window_start=$2`, [quota.quota_id,quota.window_start,quota.quoted_tokens,quota.quote_uusd]
        );
        await client.query("UPDATE quota_reservations SET released_at=now() WHERE reservation_id=$1 AND quota_id=$2", [reservationId,quota.quota_id]);
      }
      await this.#ledgerEvent(client, { tenantId:reservation.tenant_id,requestId:reservation.request_id,reservationId,windowStart:reservation.window_start,type:"released",reservedDelta:-integer(reservation.quote_uusd),pricingVersion:reservation.pricing_version,configVersion:reservation.config_version,idempotencyKey:"released:"+reservationId,payload:{reason} });
      await client.query("COMMIT");
      return { released:true,duplicate:false };
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async claimReconciliationJobs({ limit = 20, staleAfterMs = 120_000 } = {}) {
    const result = await this.pool.query(
      `WITH due AS (
         SELECT j.reservation_id,r.state AS reservation_state,r.request_id,r.quote_uusd FROM reconciliation_jobs j
         JOIN reservations r USING(reservation_id)
         WHERE j.state IN ('pending','retry','in_progress') AND j.next_attempt_at <= now()
           AND (j.state <> 'in_progress' OR j.locked_at < now() - ($2::bigint * interval '1 millisecond'))
           AND r.state IN ('active','provider_started','reconcile_required')
         ORDER BY j.next_attempt_at,j.created_at
         LIMIT $1 FOR UPDATE OF j SKIP LOCKED
       )
       UPDATE reconciliation_jobs j SET state='in_progress',attempts=j.attempts+1,locked_at=now()
       FROM due WHERE j.reservation_id=due.reservation_id
       RETURNING j.reservation_id,j.tenant_id,j.provider,j.provider_request_id,j.attempts,j.created_at,due.reservation_state,due.request_id,due.quote_uusd`,
      [limit,staleAfterMs]
    );
    return result.rows;
  }

  async getReconciliationBacklog(){
    const [reconcile,outbox]=await Promise.all([
      this.pool.query("SELECT count(*)::bigint AS count,COALESCE(extract(epoch from now()-min(created_at)),0)::bigint AS oldest_age_seconds FROM reconciliation_jobs WHERE state IN ('pending','retry','in_progress','dead_letter')"),
      this.pool.query("SELECT count(*)::bigint AS count FROM billing_outbox WHERE state IN ('pending','in_progress','dead_letter')")
    ]);
    return {reconciliation_count:integer(reconcile.rows[0].count),oldest_age_seconds:integer(reconcile.rows[0].oldest_age_seconds),outbox_count:integer(outbox.rows[0].count)};
  }

  async retryReconciliation({ reservationId, error, maxAttempts = 8, backoffMs = 30_000 }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT * FROM reconciliation_jobs WHERE reservation_id=$1 FOR UPDATE", [reservationId]);
      const job = result.rows[0];
      if (!job) throw new Error("Reconciliation job not found.");
      const reason = String(error?.message ?? error ?? "Provider outcome remains unknown").slice(0,1000);
      if (job.attempts >= maxAttempts) {
        await client.query("UPDATE reconciliation_jobs SET state='dead_letter',last_error=$2,locked_at=NULL WHERE reservation_id=$1", [reservationId,reason]);
        await client.query("INSERT INTO reconciliation_dead_letters (reservation_id,tenant_id,reason,attempts,payload) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (reservation_id) DO NOTHING", [reservationId,job.tenant_id,reason,job.attempts,JSON.stringify({ provider:job.provider,provider_request_id:job.provider_request_id })]);
      } else {
        const delay = Math.min(3_600_000, backoffMs * (2 ** Math.max(0,job.attempts-1)));
        await client.query("UPDATE reconciliation_jobs SET state='retry',next_attempt_at=now()+($2::bigint*interval '1 millisecond'),last_error=$3,locked_at=NULL WHERE reservation_id=$1", [reservationId,delay,reason]);
      }
      await client.query("COMMIT");
      return { deadLetter:job.attempts >= maxAttempts };
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async claimOutboxEvents({ limit = 50, staleAfterMs = 60_000 } = {}) {
    const result=await this.pool.query(
      `WITH due AS (
         SELECT outbox_id FROM billing_outbox
         WHERE state IN ('pending','in_progress') AND available_at<=now()
           AND (state<>'in_progress' OR locked_at<now()-($2::bigint*interval '1 millisecond'))
         ORDER BY available_at,outbox_id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE billing_outbox e SET state='in_progress',attempts=e.attempts+1,locked_at=now()
       FROM due WHERE e.outbox_id=due.outbox_id
       RETURNING e.outbox_id,e.event_key,e.payload,e.attempts`,[limit,staleAfterMs]
    );
    return result.rows;
  }

  async markOutboxPublished(outboxId) {
    const result=await this.pool.query("UPDATE billing_outbox SET state='published',published_at=now(),locked_at=NULL,last_error=NULL WHERE outbox_id=$1 AND state='in_progress'",[outboxId]);
    return result.rowCount===1;
  }

  async retryOutbox({ outboxId, error, maxAttempts = 12, backoffMs = 5_000 }) {
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const result=await client.query("SELECT * FROM billing_outbox WHERE outbox_id=$1 FOR UPDATE",[outboxId]);
      const item=result.rows[0];
      if(!item){await client.query("COMMIT");return {deadLetter:false};}
      const message=String(error?.message??error??"Outbox publisher failed").slice(0,1000);
      const dead=item.attempts>=maxAttempts;
      const delay=Math.min(3_600_000,backoffMs*(2**Math.max(0,item.attempts-1)));
      await client.query("UPDATE billing_outbox SET state=$2,available_at=CASE WHEN $2='pending' THEN now()+($3::bigint*interval '1 millisecond') ELSE available_at END,locked_at=NULL,last_error=$4 WHERE outbox_id=$1",[outboxId,dead?"dead_letter":"pending",delay,message]);
      await client.query("COMMIT");
      return {deadLetter:dead};
    }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
    finally{client.release();}
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
      if (seeded_settled_uusd > 0) {
        await this.#ledgerEvent(client, { tenantId:id,windowStart:window.window_start,type:"adjusted",amount:seeded_settled_uusd,idempotencyKey:"tenant-seed:"+id+":"+window.window_start,payload:{source:"seedTenant"} });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}
