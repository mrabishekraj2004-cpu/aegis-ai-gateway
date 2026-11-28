import test from "node:test";
import assert from "node:assert/strict";
import { ApiKeyService, verifyApiKey } from "../src/api-keys.js";
import { OpenAIAdapter, OpenAIResponsesAdapter, AnthropicAdapter, ProviderError } from "../src/providers.js";
import { PolicyRouter } from "../src/policy-router.js";
import { MemoryLedger } from "../src/ledger.js";
import { MockProvider } from "../src/mock-provider.js";
import { createGateway } from "../src/gateway.js";
import { handleAdminRequest } from "../src/admin-api.js";

const pepper = "test-pepper-with-at-least-thirty-two-characters";

test("API keys are returned once, stored as hashes, scoped, and revocable", async () => {
  const records = new Map();
  const store = {
    async createApiKey(record) { records.set(record.key_id, record); },
    async getApiKey(id) { return records.get(id); },
    async revokeApiKey({keyId}) { const row=records.get(keyId); if(!row)return false; row.revoked_at=new Date().toISOString(); return true; }
  };
  const service = new ApiKeyService({ store, pepper });
  const created = await service.create({ tenantId:"tenant_synth",userId:"user_synth",name:"test key",scopes:["gateway:invoke","usage:read"],environment:"test" });
  const row=records.get(created.id);
  assert.match(created.key,/^aegis_test_/);
  assert.equal("key" in row,false);
  assert.equal(verifyApiKey(created.key,row.key_hash,pepper),true);
  assert.deepEqual(row.scopes,["gateway:invoke","usage:read"]);
  assert.equal(await service.revoke({keyId:created.id,tenantId:"tenant_synth",actor:"user_synth",reason:"test"}),true);
});

test("OpenAI and Anthropic adapters normalize response text, usage, cost, and request IDs", async () => {
  const route={provider:"openai",model:"gpt-test",alias:"fast",pricing:{input_usd_per_million:2,output_usd_per_million:8}};
  const openai=new OpenAIAdapter({apiKey:"test-secret",baseUrl:"https://provider.test/v1",fetchImpl:async(url,init)=>{
    assert.equal(url,"https://provider.test/v1/chat/completions");
    assert.equal(init.headers.Authorization,"Bearer test-secret");
    return new Response(JSON.stringify({id:"chat_1",choices:[{message:{content:"hello"}}],usage:{prompt_tokens:10,completion_tokens:4}}),{status:200,headers:{"x-request-id":"upstream_1"}});
  }});
  const a=await openai.invoke({route,prompt:"hi",maxTokens:16,requestId:"req_1"});
  assert.equal(a.response,"hello");
  assert.equal(a.provider_request_id,"chat_1");
  assert.equal(a.usage.input_tokens,10);
  assert.equal(a.usage.output_tokens,4);
  assert.equal(a.usage.cost_uusd,52);

  const anthropic=new AnthropicAdapter({apiKey:"test-secret",baseUrl:"https://provider.test/v1",fetchImpl:async(url,init)=>{
    assert.equal(url,"https://provider.test/v1/messages");
    assert.equal(init.headers["x-api-key"],"test-secret");
    return new Response(JSON.stringify({id:"msg_1",content:[{type:"text",text:"world"}],usage:{input_tokens:5,output_tokens:3}}),{status:200});
  }});
  const b=await anthropic.invoke({route:{...route,provider:"anthropic",model:"claude-test"},prompt:"hi",maxTokens:16});
  assert.equal(b.response,"world");
  assert.equal(b.provider_request_id,"msg_1");
  assert.equal(b.usage.cost_uusd,34);
});

test("provider connection uncertainty prevents duplicate-charge failover", async () => {
  let backupCalls=0;
  const providers=new Map([
    ["first",{name:"first",quote:async()=>100,invoke:async()=>{throw new ProviderError("unknown",{provider:"first",retryable:true,outcomeUnknown:true});}}],
    ["backup",{name:"backup",quote:async()=>100,invoke:async()=>{backupCalls++;return {kind:"success",response:"backup",usage:{cost_uusd:100}};}}]
  ]);
  const router=new PolicyRouter({providers,config:{version:"v1",aliases:{chat:[
    {provider:"first",model:"m1",priority:1,weight:1,max_cost_uusd:100},
    {provider:"backup",model:"m2",priority:2,weight:1,max_cost_uusd:100}
  ]},tenants:{}}});
  const route=await router.resolveRoute("chat",{requestId:"request-1"});
  const failoverRoutes=await router.getFailovers(route,{prompt:"x",maxTokens:1});
  await assert.rejects(router.invoke(route,{prompt:"x",maxTokens:1,failoverRoutes}),error=>error instanceof ProviderError&&error.outcomeUnknown);
  assert.equal(backupCalls,0);
});

test("OpenAI Responses adapter persists response IDs and reconciles usage by response ID", async () => {
  const savedIds=[];
  const route={provider:"openai",model:"gpt-test",alias:"fast",pricing_version:"p1",config_version:"c1",pricing:{input_usd_per_million:2,output_usd_per_million:8}};
  const adapter=new OpenAIResponsesAdapter({apiKey:"test-secret",baseUrl:"https://provider.test/v1",fetchImpl:async(url,init)=>{
    if(init.method==="GET"){
      assert.equal(url,"https://provider.test/v1/responses/resp_1");
      return new Response(JSON.stringify({id:"resp_1",status:"completed",usage:{input_tokens:10,output_tokens:4}}),{status:200});
    }
    assert.equal(url,"https://provider.test/v1/responses");
    assert.equal(JSON.parse(init.body).store,true);
    return new Response(JSON.stringify({id:"resp_1",status:"completed",output_text:"hello",usage:{input_tokens:10,output_tokens:4}}),{status:200});
  }});
  const invoked=await adapter.invoke({route,prompt:"hi",maxTokens:8,onProviderRequestId:id=>savedIds.push(id)});
  assert.equal(invoked.response,"hello");
  assert.equal(invoked.provider_request_id,"resp_1");
  assert.deepEqual(savedIds,["resp_1"]);
  const result=await adapter.reconcile({providerRequestId:"resp_1",route});
  assert.equal(result.kind,"usage");
  assert.equal(result.usage.input_tokens,10);
  assert.equal(result.usage.output_tokens,4);
  assert.equal(result.usage.cost_uusd,52);
});

test("deterministic mock receipts can reconcile after the request handler loses its response", async () => {
  const provider=new MockProvider();
  const route={provider:"mock",model:"mock-chat-v1",alias:"demo-model",region:"global",config_version:"cfg-1",pricing_version:"mock-v1",pricing:{input_usd_per_million:1,output_usd_per_million:1}};
  const ids=[];
  const result=await provider.invoke({route,requestId:"req_mock_reconcile",onProviderRequestId:id=>ids.push(id)});
  assert.equal(result.kind,"success");
  assert.deepEqual(ids,["mock:req_mock_reconcile"]);
  const reconciled=await provider.reconcile({providerRequestId:ids[0],requestId:"req_mock_reconcile",route});
  assert.equal(reconciled.kind,"usage");
  assert.equal(reconciled.usage.cost_uusd,340_000);
});

test("known pre-execution provider failures may fail over without recording a second charge", async () => {
  const starts=[];
  const providers=new Map([
    ["first",{name:"first",quote:async()=>100,invoke:async()=>{throw new ProviderError("busy",{provider:"first",retryable:true,outcomeUnknown:false});}}],
    ["backup",{name:"backup",quote:async()=>100,invoke:async()=>({kind:"success",response:"ok",usage:{cost_uusd:100}})}]
  ]);
  const router=new PolicyRouter({providers,config:{version:"v1",aliases:{chat:[
    {provider:"first",model:"m1",priority:1,weight:1,max_cost_uusd:100},
    {provider:"backup",model:"m2",priority:2,weight:1,max_cost_uusd:100}
  ]},tenants:{}}});
  const route=await router.resolveRoute("chat",{requestId:"request-2"});
  const failoverRoutes=await router.getFailovers(route,{prompt:"x",maxTokens:1});
  const result=await router.invoke(route,{prompt:"x",maxTokens:1,failoverRoutes,beforeProviderStart:async(candidate,attempt)=>{starts.push([candidate.provider,attempt]);return true;}});
  assert.equal(result.response,"ok");
  assert.equal(result.selectedRoute.provider,"backup");
  assert.deepEqual(starts,[["first",1],["backup",2]]);
});

test("provider concurrency queues one request and rejects excess work with retry guidance", async () => {
  let releaseFirst,markStarted;
  const firstStarted=new Promise(resolve=>{markStarted=resolve;});
  const blockFirst=new Promise(resolve=>{releaseFirst=resolve;});
  let calls=0;
  const adapter={name:"mock",quote:async()=>1,invoke:async()=>{calls++;if(calls===1){markStarted();await blockFirst;}return {kind:"success",response:"ok",usage:{cost_uusd:1}};}};
  const router=new PolicyRouter({providers:new Map([["mock",adapter]]),maxConcurrency:1,maxQueueDepth:1,queueTimeoutMs:1000});
  const route={provider:"mock",model:"m"};
  const first=router.invoke(route,{});
  await firstStarted;
  const second=router.invoke(route,{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(router.getProviderHealth()[0].queued,1);
  await assert.rejects(router.invoke(route,{}),error=>error.code==="provider_overloaded"&&error.retryAfter===1);
  releaseFirst();
  await Promise.all([first,second]);
  assert.equal(calls,2);
  assert.equal(router.getProviderHealth()[0].active,0);
  assert.equal(router.getProviderHealth()[0].queued,0);
});

test("cancelling a queued provider request removes it without invoking the provider", async () => {
  let releaseFirst,markStarted;
  const firstStarted=new Promise(resolve=>{markStarted=resolve;});
  const blockFirst=new Promise(resolve=>{releaseFirst=resolve;});
  let calls=0;
  const adapter={name:"mock",quote:async()=>1,invoke:async()=>{calls++;if(calls===1){markStarted();await blockFirst;}return {kind:"success",response:"ok",usage:{cost_uusd:1}};}};
  const router=new PolicyRouter({providers:new Map([["mock",adapter]]),maxConcurrency:1,maxQueueDepth:2,queueTimeoutMs:1000});
  const route={provider:"mock",model:"m"};
  const first=router.invoke(route,{});
  await firstStarted;
  const controller=new AbortController();
  const queued=router.invoke(route,{signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  await assert.rejects(queued,error=>error.code==="client_cancelled");
  releaseFirst();
  await first;
  assert.equal(calls,1);
  assert.equal(router.getProviderHealth()[0].queued,0);
});

test("SSE stream settles partial usage after client disconnect and cancels provider work", async () => {
  const store=new MemoryLedger({tenants:[{id:"tenant_stream",name:"Streaming test",limit_uusd:1_000_000,seeded_settled_uusd:0}]});
  const provider=new MockProvider();
  const gateway=createGateway({mode:"test",credentials:new Map([["stream-token","tenant_stream"]]),store,provider});
  const controller=new AbortController();
  const result=await gateway.handle({method:"POST",path:"/v1/chat/completions",headers:{authorization:"Bearer stream-token","idempotency-key":"stream-partial"},signal:controller.signal,body:{model:"demo-model",messages:[{role:"user",content:"Stream a short answer"}],max_tokens:128,stream:true}});
  assert.equal(result.status,200);
  assert.match(result.headers["Content-Type"],/text\/event-stream/);
  const chunks=[];
  const response={destroyed:false,writableEnded:false,write(value){chunks.push(value);if(String(value).includes("chat.completion.chunk"))controller.abort();return true;},end(){this.writableEnded=true;}};
  await result.writeTo(response);
  const stream=chunks.join("");
  assert.match(stream,/planned_route/);
  assert.match(stream,/event: usage/);
  assert.match(stream,/\[DONE\]/);
  const overview=await store.getOverview("tenant_stream");
  assert.equal(overview.entries.length,1);
  assert.equal(overview.entries[0].status,"partial");
  assert.equal(overview.budget.reserved_uusd,0);
});

test("tenant administrators cannot read or mutate platform-wide control-plane resources", async () => {
  const calls=[];
  const store={
    async listTenants(){calls.push("listTenants");return [];},
    async createTenant(){calls.push("createTenant");return {};},
    async listPricingVersions(){calls.push("listPricingVersions");return [];},
    async createPricingVersion(){calls.push("createPricingVersion");return {};}
  };
  const principal={tenantId:"tenant_a",userId:"admin_a",role:"admin",scopes:["control:read","control:write"],platformAdmin:false};
  for (const [method,path,body] of [
    ["GET","/v1/admin/tenants",null],
    ["POST","/v1/admin/tenants",{tenant_id:"tenant_b",name:"Other tenant",monthly_limit_uusd:100,reason:"test"}],
    ["GET","/v1/admin/pricing",null],
    ["POST","/v1/admin/pricing",{provider:"mock",model:"m",region:"global",unit:"token",version:"v1",effective_at:"2026-01-01T00:00:00Z",reason:"test"}],
    ["POST","/v1/admin/tenants/tenant_b/members",{user_id:"owner_b",email:"owner@example.test",display_name:"Owner",reason:"bootstrap"}]
  ]) {
    const result=await handleAdminRequest({method,path,url:new URL("http://gateway.local"+path),body,principal,store});
    assert.equal(result.status,403,`${method} ${path} must be platform-admin only`);
    assert.equal(result.body.error.code,"platform_admin_required");
  }
  assert.deepEqual(calls,[]);
});

test("platform-wide control-plane access requires a server-configured platform identity", async () => {
  const principal={tenantId:"tenant_a",userId:"platform_user",role:"admin",scopes:["control:read","control:write"],platformAdmin:true};
  const store={async listTenants(){return [{tenant_id:"tenant_a"}]}};
  const result=await handleAdminRequest({method:"GET",path:"/v1/admin/tenants",url:new URL("http://gateway.local/v1/admin/tenants"),body:null,principal,store});
  assert.equal(result.status,200);
  assert.deepEqual(result.body.tenants,[{tenant_id:"tenant_a"}]);
});

test("manual reconciliation requires control write, safe evidence, and tenant scoping", async () => {
  const calls=[];
  const principal={tenantId:"tenant_a",userId:"admin_a",role:"admin",scopes:["control:read","control:write"],platformAdmin:false};
  const store={async resolveReconciliation(input){calls.push(input);return {kind:"resolved",outcome:input.outcome,entry:null};}};
  const path="/v1/admin/reconciliation/res_123/resolve";
  const base={outcome:"settled",reason:"Verified provider usage",evidence_ref:"billing-entry:abc-123",provider_request_id:"provider_req_123",input_tokens:12,output_tokens:7,cost_uusd:340000,provider_cost_uusd:340000,status:"completed"};
  const noWrite=await handleAdminRequest({method:"POST",path,url:new URL("http://gateway.local"+path),body:base,principal:{...principal,scopes:["control:read"]},store});
  assert.equal(noWrite.status,403);
  const unsafeEvidence=await handleAdminRequest({method:"POST",path,url:new URL("http://gateway.local"+path),body:{...base,evidence_ref:"https://provider.test/item?id=secret"},principal,store});
  assert.equal(unsafeEvidence.status,400);
  const result=await handleAdminRequest({method:"POST",path,url:new URL("http://gateway.local"+path),body:{...base,route:{provider:"attacker",model:"untrusted"}},principal,store});
  assert.equal(result.status,200);
  assert.deepEqual(calls[0].tenantId,"tenant_a");
  assert.equal(calls[0].actor,"admin_a");
  assert.deepEqual(calls[0].usage,{input_tokens:12,output_tokens:7,cost_uusd:340000,provider_cost_uusd:340000,status:"completed"});
  assert.equal("route" in calls[0].usage,false);
});

test("platform admins can bootstrap the first owner once for a new tenant", async () => {
  const calls=[];
  const principal={tenantId:"platform_tenant",userId:"platform_user",role:"admin",scopes:["control:read","control:write"],platformAdmin:true};
  const store={async bootstrapTenantOwner(input){calls.push(input);return {kind:"created"};}};
  const path="/v1/admin/tenants/new-tenant/members";
  const result=await handleAdminRequest({method:"POST",path,url:new URL("http://gateway.local"+path),body:{user_id:"first_owner",email:"owner@example.test",display_name:"First Owner",reason:"Tenant setup"},principal,store});
  assert.equal(result.status,201);
  assert.deepEqual(result.body,{tenant_id:"new-tenant",user_id:"first_owner",role:"owner"});
  assert.equal(calls.length,1);
  assert.equal(calls[0].tenantId,"new-tenant");
  assert.equal(calls[0].actor,"platform_user");
});

test("non-stream client cancellation aborts provider work and leaves usage pending reconciliation", async () => {
  const store=new MemoryLedger({tenants:[{id:"tenant_cancel",name:"Cancellation",limit_uusd:1_000_000,seeded_settled_uusd:0}]});
  let providerStarted;
  const started=new Promise(resolve=>{providerStarted=resolve;});
  let providerCalls=0;
  const provider={
    name:"mock",
    async quote(){return 340_000;},
    async invoke({signal}){
      providerCalls++;
      providerStarted();
      return new Promise((resolve,reject)=>{
        if(signal.aborted) return reject(new ProviderError("client disconnected",{provider:"mock",retryable:false,outcomeUnknown:true,code:"client_cancelled"}));
        signal.addEventListener("abort",()=>reject(new ProviderError("client disconnected",{provider:"mock",retryable:false,outcomeUnknown:true,code:"client_cancelled"})),{once:true});
      });
    }
  };
  const providers=new Map([["mock",provider]]);
  const router=new PolicyRouter({providers,store,config:{version:"test-v1",aliases:{"demo-model":[{provider:"mock",model:"mock-chat-v1",priority:1,weight:1,max_cost_uusd:340_000}]},tenants:{}}});
  const gateway=createGateway({mode:"test",credentials:new Map([["cancel-token","tenant_cancel"]]),store,providers,router});
  const controller=new AbortController();
  const pending=gateway.handle({method:"POST",path:"/v1/chat/completions",headers:{authorization:"Bearer cancel-token","idempotency-key":"cancel-1"},signal:controller.signal,body:{model:"demo-model",messages:[{role:"user",content:"synthetic cancellation test"}],max_tokens:10}});
  await started;
  controller.abort();
  const result=await pending;
  assert.equal(providerCalls,1);
  assert.equal(result.status,502);
  assert.equal(result.body.error.settlement_state,"reconcile_required");
  assert.equal(result.body.error.code,"provider_error");
  const reservation=store.getReservation(`res_${result.body.error.request_id}`);
  assert.equal(reservation.state,"reconcile_required");
  assert.equal(store.getOverview("tenant_cancel").entries.length,0);
  assert.equal(store.getBudget("tenant_cancel").reserved_uusd,340_000);
});
