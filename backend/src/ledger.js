function utcWindow(now) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { window_start: start.toISOString(), window_end: end.toISOString() };
}

const defaultTenants = [
  { id: "tenant_demo_aster", name: "Aster Labs", limit_uusd: 20_000_000, seeded_settled_uusd: 7_420_000 },
  { id: "tenant_demo_juniper", name: "Juniper Health", limit_uusd: 10_000_000, seeded_settled_uusd: 0 },
  { id: "tenant_demo_budget", name: "Budget Demo", limit_uusd: 340_000, seeded_settled_uusd: 0 }
];
const copy = value => structuredClone(value);
const keyFor = (tenantId, windowStart) => `${tenantId}:${windowStart}`;

export class MemoryLedger {
  constructor({ clock = () => new Date(), tenants = defaultTenants } = {}) {
    this.storageMode = "memory";
    this.clock = clock;
    this.tenants = new Map(tenants.map(tenant => [tenant.id, { ...tenant }]));
    this.budgets = new Map();
    this.reservations = new Map();
    this.usageByReservation = new Map();
    this.idempotency = new Map();
    this.requestCounter = 1;
    this.seedWindow = utcWindow(this.clock()).window_start;
    for (const tenant of this.tenants.values()) this.#budgetFor(tenant.id);
  }

  #budgetFor(tenantId) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;
    const window = utcWindow(this.clock());
    const key = keyFor(tenantId, window.window_start);
    if (!this.budgets.has(key)) {
      const isSeedWindow = window.window_start === this.seedWindow;
      this.budgets.set(key, {
        tenant_id: tenantId,
        ...window,
        limit_uusd: tenant.limit_uusd,
        settled_uusd: isSeedWindow ? tenant.seeded_settled_uusd : 0,
        reserved_uusd: 0
      });
    }
    return this.budgets.get(key);
  }

  getTenant(tenantId) {
    const tenant = this.tenants.get(tenantId);
    return tenant ? { id: tenant.id, name: tenant.name } : null;
  }

  getBudget(tenantId) {
    const budget = this.#budgetFor(tenantId);
    return budget ? copy(budget) : null;
  }

  getOverview(tenantId) {
    const tenant = this.getTenant(tenantId);
    const budget = this.#budgetFor(tenantId);
    if (!tenant || !budget) return null;
    const entries = [...this.usageByReservation.values()]
      .filter(entry => entry.tenant_id === tenantId && entry.window_start === budget.window_start)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    return { tenant, budget: copy(budget), entries: copy(entries) };
  }

  beginRequest({ tenantId, idempotencyKey, requestHash }) {
    const key = `${tenantId}:${idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.request_hash !== requestHash) return { kind: "conflict", requestId: existing.request_id };
      if (existing.state === "in_progress") return { kind: "in_progress", requestId: existing.request_id };
      return { kind: "replay", requestId: existing.request_id, status: existing.status, body: copy(existing.body) };
    }
    const requestId = `req_local_${String(this.requestCounter++).padStart(6, "0")}`;
    this.idempotency.set(key, { tenant_id: tenantId, idempotency_key: idempotencyKey, request_hash: requestHash, request_id: requestId, state: "in_progress", status: null, body: null });
    return { kind: "new", requestId, key };
  }

  completeRequest(key, { status, body }) {
    const request = this.idempotency.get(key);
    if (!request) throw new Error("Idempotency record not found.");
    request.state = "complete";
    request.status = status;
    request.body = copy(body);
  }

  reserve({ tenantId, requestId, quoteUusd }) {
    if (!Number.isSafeInteger(quoteUusd) || quoteUusd < 0) throw new Error("Reservation amount must be a non-negative safe integer.");
    const budget = this.#budgetFor(tenantId);
    if (!budget) throw new Error("Tenant not found.");
    const remaining = budget.limit_uusd - budget.settled_uusd - budget.reserved_uusd;
    if (quoteUusd > remaining) return { admitted: false, remaining_uusd: remaining, budget: copy(budget) };
    const reservationId = `res_${requestId}`;
    if (this.reservations.has(reservationId)) throw new Error("Reservation already exists for request.");
    const reservation = {
      reservation_id: reservationId,
      request_id: requestId,
      tenant_id: tenantId,
      window_start: budget.window_start,
      quote_uusd: quoteUusd,
      state: "active",
      created_at: this.clock().toISOString()
    };
    budget.reserved_uusd += quoteUusd;
    this.reservations.set(reservationId, reservation);
    return { admitted: true, remaining_uusd: remaining - quoteUusd, budget: copy(budget), reservation: copy(reservation) };
  }

  markReconcileRequired(reservationId) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error("Reservation not found.");
    if (reservation.state === "settled") return copy(reservation);
    if (reservation.state === "active") reservation.state = "reconcile_required";
    return copy(reservation);
  }

  settle({ reservationId, usage }) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error("Reservation not found.");
    if (reservation.state === "settled") return { entry: copy(this.usageByReservation.get(reservationId)), duplicate: true };
    if (reservation.state !== "active" && reservation.state !== "reconcile_required") throw new Error(`Cannot settle reservation in state ${reservation.state}.`);
    if (!Number.isSafeInteger(usage.cost_uusd) || usage.cost_uusd < 0 || usage.cost_uusd > reservation.quote_uusd) throw new Error("Actual usage must be a non-negative integer no greater than its reservation.");
    const budget = this.budgets.get(keyFor(reservation.tenant_id, reservation.window_start));
    if (!budget) throw new Error("Reservation budget window is unavailable.");
    budget.reserved_uusd -= reservation.quote_uusd;
    budget.settled_uusd += usage.cost_uusd;
    reservation.state = "settled";
    reservation.settled_at = this.clock().toISOString();
    const entry = {
      request_id: reservation.request_id,
      tenant_id: reservation.tenant_id,
      window_start: reservation.window_start,
      model: usage.model,
      route: copy(usage.route),
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
      cost_uusd: usage.cost_uusd,
      created_at: reservation.settled_at,
      status: usage.status ?? "completed"
    };
    this.usageByReservation.set(reservationId, entry);
    return { entry: copy(entry), duplicate: false };
  }

  getReservation(reservationId) {
    const reservation = this.reservations.get(reservationId);
    return reservation ? copy(reservation) : null;
  }

  getUsageCount(tenantId) {
    return [...this.usageByReservation.values()].filter(entry => entry.tenant_id === tenantId).length;
  }
}

export function currentUtcWindow(now = new Date()) {
  return utcWindow(now);
}
