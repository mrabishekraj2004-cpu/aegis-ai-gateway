export type TenantRole = "owner" | "admin" | "operator" | "viewer";

export interface TenantPrincipal {
  tenantId: string;
  userId: string;
  keyId?: string;
  role: TenantRole;
  scopes: string[];
  platformAdmin: boolean;
}

export interface ApiKeyRecord {
  key_id: string;
  key_hash: string;
  environment: "live" | "test";
  tenant_id: string;
  user_id: string;
  role: TenantRole;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

export interface AuthStore {
  authenticateApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  touchApiKey(keyId: string): Promise<void>;
}

export interface AuthHeaders {
  authorization?: string;
  Authorization?: string;
  [header: string]: unknown;
}

export interface AuthenticatorOptions {
  mode?: "disabled" | "local" | "test" | "production";
  credentials?: Map<string, string>;
  store?: AuthStore;
  keyPepper?: string;
  platformAdminUserIds?: string | string[];
}

export interface AdminStore {
  [method: string]: (...args: any[]) => any;
}

export interface AdminRequest {
  method: string;
  path: string;
  url: URL;
  body: any;
  principal: TenantPrincipal;
  store: AdminStore;
  keyService?: Record<string, (...args: any[]) => any>;
  providers?: Map<string, unknown>;
  providerHealth?: () => Array<{ name: string; [field: string]: any }>;
}

export interface ProviderRoute {
  provider: string;
  model: string;
  alias: string;
  region: string;
  config_version: string;
  pricing_version: string;
  pricing: { input_usd_per_million: number; output_usd_per_million: number };
}

export interface NormalizedUsage {
  input_tokens: number;
  output_tokens: number;
  cost_uusd: number;
  model: string;
  route: ProviderRoute;
  status: "completed" | "partial" | "partial_estimated";
}

export type ReconciliationResult =
  | { kind: "usage"; usage: NormalizedUsage }
  | { kind: "not_executed" }
  | { kind: "unknown"; message: string };

export interface ReconciliationJob {
  reservation_id: string;
  tenant_id: string;
  request_id: string;
  reservation_state: string;
  provider?: string;
  provider_request_id?: string | null;
  provider_route?: ProviderRoute | null;
}

export interface OutboxRecord {
  outbox_id: number;
  event_key: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface WorkerStore {
  storageMode: "postgres";
  pool?: { end(): Promise<void> };
  claimReconciliationJobs(options: { limit: number; staleAfterMs: number }): Promise<ReconciliationJob[]>;
  retryReconciliation(options: { reservationId: string; error: unknown; maxAttempts: number }): Promise<{ deadLetter: boolean }>;
  releaseReservation(options: { reservationId: string; reason?: string }): Promise<unknown>;
  settle(options: { reservationId: string; usage: any }): Promise<unknown>;
  getReconciliationBacklog?(): Promise<Record<string, number>>;
  claimOutboxEvents(options: { limit: number; staleAfterMs: number }): Promise<OutboxRecord[]>;
  markOutboxPublished(outboxId: number): Promise<boolean>;
  retryOutbox(options: { outboxId: number; error: unknown; maxAttempts: number }): Promise<{ deadLetter: boolean }>;
  publishIntegrationEvent(options: { payload: Record<string, unknown>; idempotencyKey: string }): Promise<unknown>;
}
