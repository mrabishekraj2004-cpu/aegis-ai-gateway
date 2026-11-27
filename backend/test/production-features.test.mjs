import test from "node:test";
import assert from "node:assert/strict";
import { ApiKeyService, verifyApiKey } from "../src/api-keys.js";
import { OpenAIAdapter, AnthropicAdapter, ProviderError } from "../src/providers.js";
import { PolicyRouter } from "../src/policy-router.js";
import { MemoryLedger } from "../src/ledger.js";
import { MockProvider } from "../src/mock-provider.js";
import { createGateway } from "../src/gateway.js";

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
  assert.equal(a.provider_request_id,"upstream_1");
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
