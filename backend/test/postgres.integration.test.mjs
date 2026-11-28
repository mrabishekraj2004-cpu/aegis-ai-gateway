import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { migrate } from "../src/migrations.js";
import { PostgresLedger } from "../src/postgres-ledger.js";
import { createGateway } from "../src/gateway.js";
import { MockProvider } from "../src/mock-provider.js";
import { ReconciliationWorker } from "../src/reconciliation-worker.js";
import { OutboxWorker } from "../src/outbox-worker.js";

const databaseUrl = process.env.AEGIS_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("CI requires AEGIS_TEST_DATABASE_URL; PostgreSQL integration checks may not be skipped.");
const testPg = databaseUrl ? test : test.skip;
const sampleBody = {
  model: "demo-model",
  messages: [{ role: "user", content: "PostgreSQL integration test" }],
  max_tokens: 128
};

async function isolatedDatabase(work) {
  const { Pool } = await import("pg");
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const schema = `aegis_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  let poolA;
  try {
    const options = `-c search_path=${schema}`;
    poolA = new Pool({ connectionString: databaseUrl, options, max: 2, connectionTimeoutMillis: 3000 });
    const migration = await migrate(poolA);
    await work({ Pool, admin, poolA, options, schema, migration, closePoolA: async () => {
      if (poolA) {
        const current = poolA;
        poolA = null;
        await current.end();
      }
    } });
  } finally {
    if (poolA) await poolA.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

const settleUsage = {
  model: "demo-model",
  route: { provider: "mock", model: "mock-chat-v1" },
  input_tokens: 128,
  output_tokens: 42,
  cost_uusd: 340_000,
  status: "completed"
};

testPg("fresh PostgreSQL schema migrates and migration reruns are idempotent", async () => {
  await isolatedDatabase(async ({ poolA, migration }) => {
    assert.deepEqual(migration.applied, ["001", "002", "003", "004"]);
    const rerun = await migrate(poolA);
    assert.deepEqual(rerun.applied, []);
    const tables = await poolA.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()");
    const names = new Set(tables.rows.map(row => row.table_name));
    for (const name of ["tenants", "budget_windows", "reservations", "usage_entries", "idempotency_records", "api_keys", "tenant_memberships", "ledger_events", "billing_outbox", "reconciliation_jobs", "integration_events", "integration_event_deliveries", "aegis_schema_migrations"]) {
      assert.ok(names.has(name), `missing ${name}`);
    }
  });
});


testPg("manual dead-letter resolution settles or releases atomically and stays tenant-scoped", async () => {
  await isolatedDatabase(async ({poolA}) => {
    const store=new PostgresLedger({pool:poolA});
    await store.seedTenant({id:"tenant_manual",name:"Manual resolution",limit_uusd:1_000_000});
    await store.seedTenant({id:"tenant_other",name:"Other tenant",limit_uusd:1_000_000});
    const route={provider:"mock",model:"mock-chat-v1",alias:"demo-model",region:"global",pricing_version:"price-manual",config_version:"cfg-manual",pricing:{input_usd_per_million:1,output_usd_per_million:1}};
    const settled=await store.reserve({tenantId:"tenant_manual",requestId:"req_manual_settle",quoteUusd:340_000,quoteTokens:100,route});
    await store.markProviderStarted({reservationId:settled.reservation.reservation_id,provider:"mock",configVersion:"cfg-manual",pricingVersion:"price-manual",route});
    await store.markProviderRequest(settled.reservation.reservation_id,"mock_receipt_settle");
    await store.markReconcileRequired(settled.reservation.reservation_id,{provider:"mock",providerRequestId:"mock_receipt_settle"});
    await store.retryReconciliation({reservationId:settled.reservation.reservation_id,error:"provider outcome uncertain",maxAttempts:0});
    const isolated=await store.resolveReconciliation({reservationId:settled.reservation.reservation_id,tenantId:"tenant_other",actor:"admin_other",reason:"Wrong tenant attempt",evidenceRef:"provider:wrong-tenant",outcome:"settled",providerRequestId:"mock_receipt_settle",usage:{input_tokens:12,output_tokens:7,cost_uusd:340_000}});
    assert.equal(isolated.kind,"not_found");
    const resolved=await store.resolveReconciliation({reservationId:settled.reservation.reservation_id,tenantId:"tenant_manual",actor:"admin_manual",reason:"Provider record confirms usage",evidenceRef:"provider:receipt-settle",outcome:"settled",providerRequestId:"mock_receipt_settle",usage:{input_tokens:12,output_tokens:7,cost_uusd:340_000,provider_cost_uusd:340_000,status:"completed"}});
    assert.equal(resolved.kind,"resolved");
    assert.equal(resolved.entry.model,"demo-model");
    assert.deepEqual(resolved.entry.route,route);
    const duplicate=await store.resolveReconciliation({reservationId:settled.reservation.reservation_id,tenantId:"tenant_manual",actor:"admin_manual",reason:"Duplicate submission",evidenceRef:"provider:receipt-settle",outcome:"settled",providerRequestId:"mock_receipt_settle",usage:{input_tokens:12,output_tokens:7,cost_uusd:340_000}});
    assert.deepEqual(duplicate,{kind:"already_resolved",outcome:"settled"});
    let overview=await store.getOverview("tenant_manual");
    assert.equal(overview.budget.settled_uusd,340_000);
    assert.equal(overview.budget.reserved_uusd,0);
    assert.equal(overview.entries.length,1);
    let dead=await poolA.query("SELECT resolved_by,resolved_at FROM reconciliation_dead_letters WHERE reservation_id=$1",[settled.reservation.reservation_id]);
    assert.equal(dead.rows[0].resolved_by,"admin_manual");
    assert.ok(dead.rows[0].resolved_at);
    let audit=await store.listAuditEvents("tenant_manual");
    assert.ok(audit.some(item=>item.action==="reconciliation.settled"&&item.actor_id==="admin_manual"&&item.payload.evidence_ref==="provider:receipt-settle"));

    const released=await store.reserve({tenantId:"tenant_manual",requestId:"req_manual_release",quoteUusd:120_000,quoteTokens:20,route});
    await store.markProviderStarted({reservationId:released.reservation.reservation_id,provider:"mock",configVersion:"cfg-manual",pricingVersion:"price-manual",route});
    await store.markReconcileRequired(released.reservation.reservation_id,{provider:"mock"});
    await store.retryReconciliation({reservationId:released.reservation.reservation_id,error:"provider lookup unresolved",maxAttempts:0});
    const release=await store.resolveReconciliation({reservationId:released.reservation.reservation_id,tenantId:"tenant_manual",actor:"admin_manual",reason:"Provider confirms no execution",evidenceRef:"provider:absence-884",outcome:"not_executed"});
    assert.equal(release.kind,"resolved");
    assert.equal(release.outcome,"not_executed");
    overview=await store.getOverview("tenant_manual");
    assert.equal(overview.budget.settled_uusd,340_000);
    assert.equal(overview.budget.reserved_uusd,0);
    assert.equal(overview.entries.length,1);
    audit=await store.listAuditEvents("tenant_manual");
    assert.ok(audit.some(item=>item.action==="reconciliation.released"&&item.actor_id==="admin_manual"&&item.payload.evidence_ref==="provider:absence-884"));
  });
});

testPg("a new tenant receives one auditable first owner atomically", async () => {
  await isolatedDatabase(async ({ poolA }) => {
    const store=new PostgresLedger({pool:poolA});
    await store.seedTenant({id:"tenant_bootstrap",name:"Bootstrap tenant",limit_uusd:1_000_000});
    const input={tenantId:"tenant_bootstrap",userId:"owner_bootstrap",email:"owner@example.test",displayName:"Initial Owner",actor:"platform_admin",reason:"Provision initial tenant owner"};
    const created=await store.bootstrapTenantOwner(input);
    assert.equal(created.kind,"created");
    assert.equal(created.role,"owner");
    const duplicate=await store.bootstrapTenantOwner({...input,userId:"owner_second",email:"second@example.test"});
    assert.equal(duplicate.kind,"already_bootstrapped");
    const members=await store.listMembers("tenant_bootstrap");
    assert.equal(members.length,1);
    assert.equal(members[0].user_id,"owner_bootstrap");
    assert.equal(members[0].role,"owner");
    const audit=await store.listAuditEvents("tenant_bootstrap");
    assert.ok(audit.some(event=>event.action==="membership.owner_bootstrapped"&&event.actor_id==="platform_admin"));
  });
});

testPg("settled usage and budget survive closing and reopening independent pools", async () => {
  await isolatedDatabase(async ({ Pool, poolA, options, closePoolA }) => {
    const first = new PostgresLedger({ pool: poolA });
    await first.seedTenant({ id: "tenant_restart", name: "Restart Tenant", limit_uusd: 500_000 });
    const begun = await first.beginRequest({ tenantId: "tenant_restart", idempotencyKey: "restart-key", requestHash: "a".repeat(64) });
    const admission = await first.reserve({ tenantId: "tenant_restart", requestId: begun.requestId, quoteUusd: 340_000 });
    const settlement = await first.settle({ reservationId: admission.reservation.reservation_id, usage: settleUsage });
    await first.completeRequest(begun.key, { status: 200, body: { id: begun.requestId, usage: { cost_uusd: settlement.entry.cost_uusd } } });
    await closePoolA();
    const restartedPool = new Pool({ connectionString: databaseUrl, options, max: 2, connectionTimeoutMillis: 3000 });
    try {
      const afterRestart = new PostgresLedger({ pool: restartedPool });
      const overview = await afterRestart.getOverview("tenant_restart");
      assert.equal(overview.budget.settled_uusd, 340_000);
      assert.equal(overview.budget.reserved_uusd, 0);
      assert.equal(overview.entries.length, 1);
      assert.equal(overview.entries[0].request_id, begun.requestId);
    } finally { await restartedPool.end(); }
  });
});

testPg("authenticated tenant overview stays isolated in PostgreSQL", async () => {
  await isolatedDatabase(async ({ poolA }) => {
    const store = new PostgresLedger({ pool: poolA });
    await store.seedTenant({ id: "tenant_a", name: "Tenant A", limit_uusd: 500_000 });
    await store.seedTenant({ id: "tenant_b", name: "Tenant B", limit_uusd: 900_000 });
    const provider = new MockProvider();
    const gateway = createGateway({
      mode: "test",
      credentials: new Map([["token-a", "tenant_a"], ["token-b", "tenant_b"]]),
      store,
      provider
    });
    const response = await gateway.handle({ method: "GET", path: "/v1/usage?tenant_id=tenant_b", headers: { authorization: "Bearer token-a", "x-tenant-id": "tenant_b" } });
    assert.equal(response.status, 200);
    assert.equal(response.body.tenant.id, "tenant_a");
    assert.equal(response.body.budget.limit_uusd, 500_000);
    assert.equal(response.body.entries.length, 0);
  });
});

testPg("exact-limit request succeeds; an over-budget request is denied before provider invocation", async () => {
  await isolatedDatabase(async ({ poolA }) => {
    const store = new PostgresLedger({ pool: poolA });
    await store.seedTenant({ id: "tenant_limit", name: "Exact Limit", limit_uusd: 340_000 });
    const provider = new MockProvider();
    const gateway = createGateway({ mode: "test", credentials: new Map([["token", "tenant_limit"]]), store, provider });
    const accepted = await gateway.handle({ method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer token", "idempotency-key": "exact" }, body: sampleBody });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.budget.settled_uusd, 340_000);
    assert.equal(accepted.body.budget.reserved_uusd, 0);
    const before = await store.getOverview("tenant_limit");
    const denied = await gateway.handle({ method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer token", "idempotency-key": "over", "x-aegis-mock-scenario": "budget_denial" }, body: sampleBody });
    const after = await store.getOverview("tenant_limit");
    assert.equal(denied.status, 429);
    assert.equal(denied.body.error.provider_called, false);
    assert.equal(provider.calls, 1);
    assert.deepEqual(after.budget, before.budget);
    assert.deepEqual(after.entries, before.entries);
  });
});

testPg("independent PostgreSQL connections cannot reserve beyond remaining budget", async () => {
  await isolatedDatabase(async ({ Pool, poolA, options }) => {
    const storeA = new PostgresLedger({ pool: poolA });
    await storeA.seedTenant({ id: "tenant_race", name: "Concurrent Tenant", limit_uusd: 340_000 });
    const poolB = new Pool({ connectionString: databaseUrl, options, max: 1, connectionTimeoutMillis: 3000 });
    try {
      const storeB = new PostgresLedger({ pool: poolB });
      const [clientA, clientB] = await Promise.all([poolA.connect(), poolB.connect()]);
      try {
        const [pidA, pidB] = await Promise.all([clientA.query("SELECT pg_backend_pid() AS pid"), clientB.query("SELECT pg_backend_pid() AS pid")]);
        assert.notEqual(pidA.rows[0].pid, pidB.rows[0].pid, "requests must use distinct PostgreSQL sessions");
      } finally { clientA.release(); clientB.release(); }
      const results = await Promise.all([
        storeA.reserve({ tenantId: "tenant_race", requestId: "req_race_a", quoteUusd: 340_000 }),
        storeB.reserve({ tenantId: "tenant_race", requestId: "req_race_b", quoteUusd: 340_000 })
      ]);
      assert.deepEqual(results.map(result => result.admitted).sort(), [false, true]);
      const budget = await storeA.getBudget("tenant_race");
      assert.ok(budget.settled_uusd + budget.reserved_uusd <= budget.limit_uusd);
      assert.equal(budget.reserved_uusd, 340_000);
    } finally { await poolB.end(); }
  });
});

testPg("duplicate settlement charges once and writes one usage entry", async () => {
  await isolatedDatabase(async ({ poolA }) => {
    const store = new PostgresLedger({ pool: poolA });
    await store.seedTenant({ id: "tenant_settle", name: "Settlement Tenant", limit_uusd: 340_000 });
    const reservation = await store.reserve({ tenantId: "tenant_settle", requestId: "req_settle_once", quoteUusd: 340_000 });
    const first = await store.settle({ reservationId: reservation.reservation.reservation_id, usage: settleUsage });
    const duplicate = await store.settle({ reservationId: reservation.reservation.reservation_id, usage: settleUsage });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(await store.getUsageCount("tenant_settle"), 1);
    const budget = await store.getBudget("tenant_settle");
    assert.equal(budget.settled_uusd, 340_000);
    assert.equal(budget.reserved_uusd, 0);
  });
});

testPg("provider failure persists a reconciliation reservation without usage", async () => {
  await isolatedDatabase(async ({ poolA }) => {
    const store = new PostgresLedger({ pool: poolA });
    await store.seedTenant({ id: "tenant_failure", name: "Failure Tenant", limit_uusd: 500_000 });
    const provider = new MockProvider();
    const gateway = createGateway({ mode: "test", credentials: new Map([["token", "tenant_failure"]]), store, provider });
    const response = await gateway.handle({ method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer token", "idempotency-key": "failure", "x-aegis-mock-scenario": "provider_failure" }, body: sampleBody });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.settlement_state, "reconcile_required");
    assert.equal((await store.getBudget("tenant_failure")).reserved_uusd, 340_000);
    assert.equal(await store.getUsageCount("tenant_failure"), 0);
    assert.equal(provider.calls, 1);
  });
});

testPg("crash recovery releases pre-provider reservations and settles confirmed provider usage once", async () => {
  await isolatedDatabase(async ({ poolA }) => {
    const store=new PostgresLedger({pool:poolA});
    await store.seedTenant({id:"tenant_crash",name:"Crash Recovery",limit_uusd:1_000_000});
    const beforeProvider=await store.reserve({tenantId:"tenant_crash",requestId:"req_crash_reserved",quoteUusd:340_000});
    const afterProvider=await store.reserve({tenantId:"tenant_crash",requestId:"req_crash_success",quoteUusd:340_000});
    const route={provider:"mock",model:"mock-chat-v1",alias:"demo-model",region:"global",pricing_version:"price-2",config_version:"cfg-7",pricing:{input_usd_per_million:0.1,output_usd_per_million:0.2}};
    await store.markProviderStarted({reservationId:afterProvider.reservation.reservation_id,provider:"mock",configVersion:"cfg-7",pricingVersion:"price-2",route});
    await store.markProviderRequest(afterProvider.reservation.reservation_id,"provider_receipt_synthetic");
    await poolA.query("UPDATE reconciliation_jobs SET next_attempt_at=now()-interval '1 second' WHERE reservation_id=ANY($1::text[])",[[beforeProvider.reservation.reservation_id,afterProvider.reservation.reservation_id]]);
    const worker=new ReconciliationWorker({store,providers:new Map([["mock",{reconcile:async({route:storedRoute})=>{assert.deepEqual(storedRoute,route);return {kind:"usage",usage:{...settleUsage,route:storedRoute}};}}]]),staleAfterMs:0});
    const result=await worker.runOnce();
    assert.deepEqual(result.results.map(item=>item.outcome).sort(),["released_unstarted","settled"]);
    const duplicate=await worker.runOnce();
    assert.equal(duplicate.claimed,0);
    const overview=await store.getOverview("tenant_crash");
    assert.equal(overview.entries.length,1);
    assert.equal(overview.budget.settled_uusd,340_000);
    assert.equal(overview.budget.reserved_uusd,0);
    assert.equal(overview.entries[0].request_id,"req_crash_success");
  });
});

testPg("outbox worker publishes ledger events idempotently to the integration event table", async () => {
  await isolatedDatabase(async ({poolA})=>{
    const store=new PostgresLedger({pool:poolA});
    await store.seedTenant({id:"tenant_outbox",name:"Outbox Tenant",limit_uusd:500_000});
    const reservation=await store.reserve({tenantId:"tenant_outbox",requestId:"req_outbox",quoteUusd:340_000});
    await store.settle({reservationId:reservation.reservation.reservation_id,usage:settleUsage});
    const worker=new OutboxWorker({store,publish:(payload,{idempotencyKey})=>store.publishIntegrationEvent({payload,idempotencyKey}),batchSize:20});
    const first=await worker.runOnce();
    assert.equal(first.claimed,3);
    assert.equal(first.results.filter(result=>result.outcome==="published").length,3);
    const events=await poolA.query("SELECT event_key,event_type FROM integration_events ORDER BY event_key");
    assert.equal(events.rowCount,3);
    const states=await poolA.query("SELECT state,count(*)::int AS count FROM billing_outbox GROUP BY state");
    assert.deepEqual(states.rows,[{state:"published",count:3}]);
    const second=await worker.runOnce();
    assert.equal(second.claimed,0);
  });
});

testPg("routing rollback creates a new published version and an audit event", async () => {
  await isolatedDatabase(async ({ poolA }) => {
    const store=new PostgresLedger({pool:poolA});
    await store.seedTenant({id:"tenant_route_rollback",name:"Route Rollback",limit_uusd:1_000_000});
    const original={aliases:{"model-a":[{provider:"mock",model:"mock-a",priority:1,weight:100}]}};
    const changed={aliases:{"model-a":[{provider:"mock",model:"mock-b",priority:1,weight:100}]}};
    const first=await store.createRoutingDraft({tenantId:"tenant_route_rollback",config:original,actor:"owner_route",reason:"Initial route"});
    await store.publishRoutingConfig({versionId:first.version_id,tenantId:"tenant_route_rollback",actor:"owner_route",reason:"Publish initial route"});
    const second=await store.createRoutingDraft({tenantId:"tenant_route_rollback",config:changed,actor:"owner_route",reason:"Change route"});
    await store.publishRoutingConfig({versionId:second.version_id,tenantId:"tenant_route_rollback",actor:"owner_route",reason:"Publish changed route"});
    const rollback=await store.rollbackRoutingConfig({versionId:first.version_id,tenantId:"tenant_route_rollback",actor:"owner_route",reason:"Restore approved route"});
    assert.ok(rollback);
    assert.notEqual(String(rollback.version_id),String(first.version_id));
    assert.equal(String(rollback.rolled_back_from),String(second.version_id));
    const active=await store.getActiveRoutingConfig("tenant_route_rollback");
    assert.deepEqual(active.aliases,original.aliases);
    const versions=await store.listRoutingConfigs("tenant_route_rollback");
    assert.equal(versions.find(row=>String(row.version_id)===String(second.version_id)).state,"rolled_back");
    assert.equal(versions.find(row=>String(row.version_id)===String(rollback.version_id)).state,"published");
    const audit=await store.listAuditEvents("tenant_route_rollback");
    const event=audit.find(row=>row.action==="routing.rolled_back");
    assert.ok(event);
    assert.equal(event.actor_id,"owner_route");
    assert.equal(event.payload.rolled_back_to_version,String(first.version_id));
  });
});

testPg("user request, token, cost, and concurrency quotas are reserved atomically", async () => {
  await isolatedDatabase(async ({ poolA }) => {
    const store=new PostgresLedger({pool:poolA});
    await store.seedTenant({id:"tenant_quota",name:"Quota Tenant",limit_uusd:1_000_000});
    await store.createQuotaPolicy({tenantId:"tenant_quota",principalId:"user_quota",period:"day",requestLimit:1,tokenLimit:1000,costLimitUusd:340_000,concurrencyLimit:1,actor:"user_quota",reason:"integration test"});
    const first=await store.reserve({tenantId:"tenant_quota",userId:"user_quota",requestId:"req_quota_1",quoteUusd:340_000,quoteTokens:170});
    assert.equal(first.admitted,true);
    const concurrent=await store.reserve({tenantId:"tenant_quota",userId:"user_quota",requestId:"req_quota_2",quoteUusd:1,quoteTokens:1});
    assert.equal(concurrent.admitted,false);
    assert.equal(concurrent.reason,"concurrency_limit");
    await store.releaseReservation({reservationId:first.reservation.reservation_id,reason:"test_release"});
    const afterRelease=await store.reserve({tenantId:"tenant_quota",userId:"user_quota",requestId:"req_quota_3",quoteUusd:1,quoteTokens:1});
    assert.equal(afterRelease.admitted,false);
    assert.equal(afterRelease.reason,"quota_exceeded");
  });
});
