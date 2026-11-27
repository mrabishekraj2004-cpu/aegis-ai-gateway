import { randomUUID } from "node:crypto";

const env=process.env;
if(env.AEGIS_LIVE_PROVIDER_TEST_CONFIRM!=="yes")throw new Error("Set AEGIS_LIVE_PROVIDER_TEST_CONFIRM=yes only after confirming isolated test tenants and hard caps.");
if(!env.AEGIS_LIVE_PROVIDER_TEST_API_URL)throw new Error("Set AEGIS_LIVE_PROVIDER_TEST_API_URL.");
const base=new URL(env.AEGIS_LIVE_PROVIDER_TEST_API_URL);
const localHosts=new Set(["localhost","127.0.0.1","::1","[::1]"]);
if(base.protocol!=="https:"&&!localHosts.has(base.hostname))throw new Error("Live provider checks require HTTPS except on loopback.");
if(base.username||base.password||base.search||base.hash||base.pathname!=="/")throw new Error("The API base URL must be an origin without credentials, path, query, or fragment.");
const maxSpendUusd=Number(env.AEGIS_LIVE_PROVIDER_TEST_MAX_UUSD);
if(!Number.isSafeInteger(maxSpendUusd)||maxSpendUusd<1||maxSpendUusd>340_000)throw new Error("The per-tenant hard budget cap must be from 1 through 340000 uUSD ($0.34).");
const cases=[
  {provider:"openai",alias:env.AEGIS_LIVE_OPENAI_ALIAS,key:env.AEGIS_LIVE_OPENAI_TEST_KEY},
  {provider:"anthropic",alias:env.AEGIS_LIVE_ANTHROPIC_ALIAS,key:env.AEGIS_LIVE_ANTHROPIC_TEST_KEY}
];
for(const item of cases){
  if(!item.alias||!item.key?.startsWith("aegis_test_"))throw new Error("Each provider needs a routed model alias and an aegis_test_ gateway key.");
}
if(cases[0].alias===cases[1].alias)throw new Error("Use distinct model aliases for the OpenAI and Anthropic compatibility checks.");

async function request(path,key,init={}){
  const response=await fetch(new URL(path,base.origin),{...init,signal:AbortSignal.timeout(30_000),headers:{Authorization:"Bearer "+key,...init.headers}});
  const body=await response.json().catch(()=>null);
  return {response,body};
}

const prepared=[];
for(const item of cases){
  const before=await request("/v1/usage",item.key);
  if(!before.response.ok||!before.body?.budget||!before.body?.tenant?.tenant_id)throw new Error("A provider test tenant could not be verified before any provider request.");
  const budget=before.body.budget;
  const available=Number(budget.limit_uusd)-Number(budget.settled_uusd)-Number(budget.reserved_uusd);
  if(!Number.isSafeInteger(Number(budget.limit_uusd))||Number(budget.limit_uusd)>maxSpendUusd||available<=0)throw new Error("Each provider test tenant must have a cap at or below the hard limit and positive remaining budget.");
  prepared.push({...item,before,tenantId:before.body.tenant.tenant_id});
}
if(prepared[0].tenantId===prepared[1].tenantId)throw new Error("Use separate synthetic tenants for OpenAI and Anthropic.");

for(const item of prepared){
  const call=await request("/v1/chat/completions",item.key,{
    method:"POST",
    headers:{"Content-Type":"application/json","Idempotency-Key":"provider-compat-"+item.provider+"-"+randomUUID()},
    body:JSON.stringify({model:item.alias,messages:[{role:"user",content:"Reply with the single word OK."}],max_tokens:8})
  });
  if(!call.response.ok)throw new Error(item.provider+" compatibility request stopped with HTTP "+call.response.status+" ("+(call.body?.error?.code??"gateway_error")+"); no retry was attempted.");
  const requestId=call.body?.id;
  const route=call.body?.route;
  const cost=Number(call.body?.usage?.cost_uusd);
  if(!requestId||route?.provider!==item.provider||!Number.isSafeInteger(cost)||cost>maxSpendUusd)throw new Error(item.provider+" compatibility response did not match the expected route or capped usage.");

  const after=await request("/v1/usage",item.key);
  const entry=after.body?.entries?.find(row=>row.request_id===requestId);
  if(!after.response.ok||!entry||entry.cost_uusd!==cost||entry.route?.provider!==item.provider)throw new Error(item.provider+" settled usage was not visible in the tenant ledger.");
  console.log(JSON.stringify({provider:item.provider,model_alias:item.alias,request_id:requestId,settled_cost_uusd:cost,tenant_cap_uusd:item.before.body.budget.limit_uusd,ledger_verified:true}));
}