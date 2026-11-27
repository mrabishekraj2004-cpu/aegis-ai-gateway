import { randomUUID } from "node:crypto";

const env=process.env;
if(env.AEGIS_LOAD_CONFIRM_MOCK!=="true")throw new Error("Load testing requires AEGIS_LOAD_CONFIRM_MOCK=true.");
const baseUrl=env.AEGIS_LOAD_API_URL;
const key=env.AEGIS_LOAD_TEST_KEY;
if(!baseUrl||!key)throw new Error("Set AEGIS_LOAD_API_URL and AEGIS_LOAD_TEST_KEY.");
const parsed=new URL(baseUrl);
const localHosts=new Set(["localhost","127.0.0.1","::1","[::1]"]);
const localTarget=localHosts.has(parsed.hostname);
if(!localTarget&&!parsed.hostname.endsWith(".test"))throw new Error("The load-test target must be localhost or a .test host.");
if(!localTarget&&parsed.protocol!=="https:")throw new Error("Remote .test load targets must use HTTPS.");
if(parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=="/")throw new Error("The load-test API URL must be an origin without credentials, path, query, or fragment.");
if(!key.startsWith("aegis_test_")&&!localTarget)throw new Error("Remote load testing requires an aegis_test_ key.");

const count=Number(env.AEGIS_LOAD_REQUESTS||10);
const concurrency=Number(env.AEGIS_LOAD_CONCURRENCY||5);
const maxSpendUusd=Number(env.AEGIS_LOAD_MAX_SPEND_UUSD);
const mockCostUusd=340_000;
if(!Number.isInteger(count)||count<1||count>20||!Number.isInteger(concurrency)||concurrency<1||concurrency>10)throw new Error("Request count must be 1-20 and concurrency 1-10.");
if(!Number.isSafeInteger(maxSpendUusd)||maxSpendUusd<mockCostUusd||maxSpendUusd>6_800_000||count*mockCostUusd>maxSpendUusd)throw new Error("Set a hard load cap from one request cost through $6.80 and large enough for the planned mock requests.");

const healthResponse=await fetch(new URL("/healthz",parsed.origin),{signal:AbortSignal.timeout(10_000)});
const health=await healthResponse.json().catch(()=>({}));
if(!healthResponse.ok||JSON.stringify(health.providers)!==JSON.stringify(["mock"]))throw new Error("Load run stopped: target health must report only the deterministic mock provider.");
const beforeResponse=await fetch(new URL("/v1/usage",parsed.origin),{headers:{Authorization:"Bearer "+key},signal:AbortSignal.timeout(10_000)});
const before=await beforeResponse.json().catch(()=>({}));
const budget=before.budget;
const remaining=Number(budget?.limit_uusd)-Number(budget?.settled_uusd)-Number(budget?.reserved_uusd);
if(!beforeResponse.ok||!Number.isSafeInteger(Number(budget?.limit_uusd))||Number(budget.limit_uusd)>maxSpendUusd||remaining<count*mockCostUusd)throw new Error("Load run stopped before sending traffic: tenant cap or remaining budget is below the planned mock spend.");

const results=[];
const ledgerRequestIds=[];
let next=0;
async function worker(){
  while(next<count){
    const index=next++;
    const idempotencyKey="load-"+randomUUID();
    const started=performance.now();
    try{
      const response=await fetch(new URL("/v1/chat/completions",parsed.origin),{
        method:"POST",signal:AbortSignal.timeout(30_000),
        headers:{Authorization:"Bearer "+key,"Content-Type":"application/json","Idempotency-Key":idempotencyKey},
        body:JSON.stringify({model:env.AEGIS_LOAD_MODEL||"demo-model",messages:[{role:"user",content:"Synthetic mock load check. Reply with one short sentence."}],max_tokens:128})
      });
      const body=await response.json().catch(()=>({}));
      const requestId=body?.id??body?.error?.request_id??null;
      if(response.ok&&typeof body?.id==="string")ledgerRequestIds.push(body.id);
      results[index]={status:response.status,latency_ms:performance.now()-started,code:body?.error?.code??null,request_id:requestId,cost_uusd:body?.usage?.cost_uusd??null};
    }catch(error){results[index]={status:0,latency_ms:performance.now()-started,code:error?.name??"network_error",request_id:null,cost_uusd:null};}
  }
}
await Promise.all(Array.from({length:Math.min(concurrency,count)},worker));
if(results.some(item=>item.status!==200||item.cost_uusd!==mockCostUusd)||ledgerRequestIds.length!==count||new Set(ledgerRequestIds).size!==count)throw new Error("Mock load run did not settle every request at the expected cost; inspect the sanitized result summary.");
const afterResponse=await fetch(new URL("/v1/usage",parsed.origin),{headers:{Authorization:"Bearer "+key},signal:AbortSignal.timeout(10_000)});
const after=await afterResponse.json().catch(()=>({}));
if(!afterResponse.ok||ledgerRequestIds.some(id=>!after.entries?.some(entry=>entry.request_id===id&&entry.cost_uusd===mockCostUusd)))throw new Error("Load run finished without all generated request IDs and costs appearing in usage.");
const settledSpendUusd=results.reduce((sum,item)=>sum+item.cost_uusd,0);
if(Number(after.budget?.settled_uusd)-Number(before.budget?.settled_uusd)!==settledSpendUusd)throw new Error("Load run usage ledger and settled budget delta do not agree.");

const durations=results.map(item=>item.latency_ms).sort((a,b)=>a-b);
console.log(JSON.stringify({target:parsed.origin,provider:"mock",requests:count,concurrency,maximum_spend_uusd:maxSpendUusd,settled_spend_uusd:settledSpendUusd,p50_ms:Math.round(durations[Math.floor((durations.length-1)*0.5)]),p95_ms:Math.round(durations[Math.floor((durations.length-1)*0.95)]),errors:0}));