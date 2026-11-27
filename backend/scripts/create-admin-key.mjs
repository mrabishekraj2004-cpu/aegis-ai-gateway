import { randomUUID } from "node:crypto";
import { PostgresLedger } from "../src/postgres-ledger.js";
import { ApiKeyService } from "../src/api-keys.js";

if (!process.env.DATABASE_URL || !process.env.AEGIS_KEY_PEPPER) throw new Error("Set DATABASE_URL and AEGIS_KEY_PEPPER before creating an administrative key.");
const { Pool }=await import("pg");
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:3000});
const store=new PostgresLedger({pool});
try {
  const tenantId=process.env.AEGIS_ADMIN_TENANT_ID || "tenant_aegis_admin";
  const name=process.env.AEGIS_ADMIN_TENANT_NAME || "Aegis Administration";
  const limit=Number(process.env.AEGIS_ADMIN_TENANT_LIMIT_UUSD || 100_000_000);
  const userId=process.env.AEGIS_ADMIN_USER_ID || "usr_"+randomUUID();
  const email=process.env.AEGIS_ADMIN_EMAIL;
  const displayName=process.env.AEGIS_ADMIN_NAME || "Aegis Administrator";
  if (!email) throw new Error("Set AEGIS_ADMIN_EMAIL for the first administrator.");
  if (!(await store.getTenant(tenantId))) await store.createTenant({tenantId,name,monthlyLimitUusd:limit,actor:userId,reason:"Initial administration bootstrap"});
  await store.upsertMembership({tenantId,userId,email,displayName,role:"owner",actor:userId,reason:"Initial administration bootstrap"});
  const service=new ApiKeyService({store,pepper:process.env.AEGIS_KEY_PEPPER});
  const key=await service.create({tenantId,userId,name:"Initial control-plane administrator",scopes:["admin"],createdBy:userId,environment:"live"});
  console.log("Store this one-time API key in a secret manager. It will not be shown again:");
  console.log(key.key);
} finally { await pool.end(); }
