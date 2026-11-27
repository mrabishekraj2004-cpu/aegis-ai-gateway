import { randomUUID } from "node:crypto";

const baseUrl=process.env.AEGIS_LOAD_API_URL;
const key=process.env.AEGIS_LOAD_TEST_KEY;
if(!baseUrl||!key)throw new Error("Set AEGIS_LOAD_API_URL and AEGIS_LOAD_TEST_KEY.");
if(!key.startsWith("aegis_test_")||process.env.AEGIS_LOAD_CONFIRM_MOCK!=="true")throw new Error("Load testing requires a test API key and AEGIS_LOAD_CONFIRM_MOCK=true.");
const parsed=new URL(baseUrl);
if(!["localhost","127.0.0.1","::1","[::1]"].includes(parsed.hostname)&&!parsed.hostname.endsWith(".test"))throw new Error("The load-test target must be localhost or a .test host.");
const count=Number(process.env.AEGIS_LOAD_REQUESTS||50);
const concurrency=Number(process.env.AEGIS_LOAD_CONCURRENCY||5);
if(!Number.isInteger(count)||count<1||count>1000||!Number.isInteger(concurrency)||concurrency<1||concurrency>100)throw new Error("Request count must be 1–1000 and concurrency 1–100.");
const results=[];
let next=0;
async function worker(){
  while(next<count){
    next++;
    const started=performance.now();
    try{
      const response=await fetch(new URL("/v1/chat/completions",baseUrl),{
        method:"POST",signal:AbortSignal.timeout(60_000),
        headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json","Idempotency-Key":`load-${randomUUID()}`},
        body:JSON.stringify({model:process.env.AEGIS_LOAD_MODEL||"demo-model",messages:[{role:"user",content:"Synthetic load-check request. Reply with one short sentence."}],max_tokens:128})
      });
      const body=await response.json().catch(()=>({}));
      results.push({status:response.status,latency_ms:performance.now()-started,code:body?.error?.code??null});
    }catch(error){results.push({status:0,latency_ms:performance.now()-started,code:error?.name??"network_error"});}
  }
}
await Promise.all(Array.from({length:Math.min(concurrency,count)},worker));
const durations=results.map(item=>item.latency_ms).sort((a,b)=>a-b);
const counts=Object.fromEntries([...new Set(results.map(item=>String(item.status)))].sort().map(status=>[status,results.filter(item=>String(item.status)===status).length]));
console.log(JSON.stringify({target:parsed.origin,requests:count,concurrency,status_counts:counts,p50_ms:Math.round(durations[Math.floor((durations.length-1)*0.5)]),p95_ms:Math.round(durations[Math.floor((durations.length-1)*0.95)]),errors:results.filter(item=>item.status===0).map(item=>item.code)}));
if(results.some(item=>item.status===0))process.exitCode=1;
