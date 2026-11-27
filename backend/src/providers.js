import { MockProvider } from "./mock-provider.js";
import { ProviderAdapter } from "./provider-interface.js";

export class ProviderError extends Error {
  constructor(message, { provider, code = "provider_error", retryable = false, outcomeUnknown = true, requestId, status, retryAfter } = {}) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
    this.requestId = requestId;
    this.status = status;
    this.retryAfter = retryAfter ?? null;
  }
}

function timeoutSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function jsonRequest({ provider, url, apiKey, body, headers = {}, bearer = true, signal, timeoutMs = 30_000, fetchImpl = fetch, onProviderRequestId }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST", signal: timeoutSignal(signal, timeoutMs),
      headers: { "Content-Type": "application/json", ...(bearer?{Authorization:`Bearer ${apiKey}`}:{ }), ...headers },
      body: JSON.stringify(body)
    });
  } catch {
    const cancelled = signal?.aborted === true;
    throw new ProviderError(cancelled ? "The client disconnected while the provider outcome was unknown." : "Provider connection failed before a response was received.", { provider, retryable: !cancelled, outcomeUnknown: true, code: cancelled ? "client_cancelled" : "provider_connection_error" });
  }
  const text = await readLimitedText(response,Number(process.env.AEGIS_MAX_PROVIDER_RESPONSE_BYTES||4_000_000),provider);
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch { result = {}; }
  if (response.ok && result?.id && onProviderRequestId) await onProviderRequestId(result.id);
  if (!response.ok) {
    throw new ProviderError(`Provider returned HTTP ${response.status}.`, {
      provider, status: response.status, requestId: response.headers.get("x-request-id") ?? undefined,
      retryable: response.status === 429 || response.status >= 500,
      outcomeUnknown: response.status >= 500,
      code: result?.error?.code ?? "provider_http_error"
    });
  }
  return { result, requestId: response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? result.id ?? null };
}

async function readLimitedText(response,maxBytes,provider){
  const declared=Number(response.headers.get("content-length")||0);
  if(declared>maxBytes){await response.body?.cancel().catch(()=>{});throw new ProviderError("Provider response exceeded the configured size limit.",{provider,outcomeUnknown:true,retryable:false,code:"provider_response_too_large"});}
  if(!response.body)return "";
  const reader=response.body.getReader();const chunks=[];let size=0;
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>maxBytes){await reader.cancel().catch(()=>{});throw new ProviderError("Provider response exceeded the configured size limit.",{provider,outcomeUnknown:true,retryable:false,code:"provider_response_too_large"});}
      chunks.push(Buffer.from(value));
    }
  }finally{reader.releaseLock();}
  return Buffer.concat(chunks,size).toString("utf8");
}

function costFromUsage(route, usage) {
  const p = route.pricing;
  if (!p) return null;
  return Math.ceil(Number(usage.input_tokens ?? 0) * Number(p.input_usd_per_million) / 1_000_000 * 1_000_000)
    + Math.ceil(Number(usage.output_tokens ?? 0) * Number(p.output_usd_per_million) / 1_000_000 * 1_000_000);
}

export class OpenAIAdapter extends ProviderAdapter {
  constructor({ apiKey, baseUrl = "https://api.openai.com/v1", fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    super("openai");this.apiKey = apiKey; this.baseUrl = baseUrl.replace(/\/$/, ""); this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async invoke({ route, prompt, messages = [{ role: "user", content: prompt }], maxTokens, signal, requestId, onProviderRequestId }) {
    if (!this.apiKey) throw new ProviderError("OpenAI is not configured.", { provider: this.name, outcomeUnknown: false, retryable: false });
    const { result, requestId: upstreamId } = await jsonRequest({ provider: this.name, url: `${this.baseUrl}/chat/completions`, apiKey: this.apiKey, fetchImpl: this.fetch, timeoutMs: this.timeoutMs, signal, onProviderRequestId, headers: requestId ? { "X-Client-Request-Id": requestId } : {}, body: { model: route.model, messages, max_tokens: maxTokens } });
    const usage = { input_tokens: result.usage?.prompt_tokens ?? 0, output_tokens: result.usage?.completion_tokens ?? 0 };
    return { kind: "success", response: result.choices?.[0]?.message?.content ?? "", provider_request_id: result.id ?? upstreamId, upstream_request_id:upstreamId, usage: { ...usage, model: route.alias, route, provider_cost_uusd: Number.isSafeInteger(result.usage?.cost_uusd) ? result.usage.cost_uusd : null, cost_uusd: costFromUsage(route, usage), status: "completed" } };
  }
  async reconcile({ providerRequestId }) {
    return { kind: "unknown", message: providerRequestId
      ? "OpenAI Chat Completions does not provide a retrieve-by-completion endpoint."
      : "OpenAI did not return a completion ID before the gateway lost the result." };
  }
  async *stream({ route, prompt, messages = [{ role: "user", content: prompt }], maxTokens, signal }) {
    if (!this.apiKey) throw new ProviderError("OpenAI is not configured.", { provider: this.name, outcomeUnknown: false });
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/chat/completions`, { method: "POST", signal: timeoutSignal(signal, this.timeoutMs), headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: route.model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }) });
    } catch { throw new ProviderError("OpenAI stream connection failed.", { provider: this.name, outcomeUnknown: true, retryable: true }); }
    if (!response.ok || !response.body) throw new ProviderError(`OpenAI returned HTTP ${response.status}.`, { provider: this.name, status: response.status, retryable: response.status === 429 || response.status >= 500, outcomeUnknown: response.status >= 500 });
    yield { type: "meta", provider_request_id: response.headers.get("x-request-id") };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6); if (data === "[DONE]") continue;
          let event; try { event = JSON.parse(data); } catch { continue; }
          if (event.id) yield { type:"meta",provider_request_id:event.id };
          const token = event.choices?.[0]?.delta?.content;
          if (token) yield { type: "delta", text: token };
          if (event.usage) usage = { input_tokens: event.usage.prompt_tokens ?? 0, output_tokens: event.usage.completion_tokens ?? 0 };
        }
        if (done) break;
      }
    } finally { reader.releaseLock(); }
    if (usage) yield { type: "usage", usage: { ...usage, model: route.alias, route, cost_uusd: costFromUsage(route, usage), status: "completed" } };
    yield { type: "done" };
  }
}

export class OpenAIResponsesAdapter extends ProviderAdapter {
  constructor({ apiKey, baseUrl = "https://api.openai.com/v1", fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    super("openai");this.apiKey=apiKey;this.baseUrl=baseUrl.replace(/\/$/,"");this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
  }
  async invoke({ route, messages, prompt, maxTokens, signal, requestId, onProviderRequestId }) {
    if (!this.apiKey) throw new ProviderError("OpenAI is not configured.",{provider:this.name,outcomeUnknown:false,retryable:false});
    const { result }=await jsonRequest({provider:this.name,url:`${this.baseUrl}/responses`,apiKey:this.apiKey,fetchImpl:this.fetch,timeoutMs:this.timeoutMs,signal,onProviderRequestId,headers:requestId?{"X-Client-Request-Id":requestId}:{},body:{model:route.model,input:messages??[{role:"user",content:prompt}],max_output_tokens:maxTokens,store:true}});
    const usage={input_tokens:result.usage?.input_tokens??0,output_tokens:result.usage?.output_tokens??0};
    const responseText=result.output_text??(result.output??[]).flatMap(item=>item.content??[]).filter(item=>item.type==="output_text").map(item=>item.text).join("");
    return {kind:"success",response:responseText,provider_request_id:result.id??null,usage:{...usage,model:route.alias,route,provider_cost_uusd:Number.isSafeInteger(result.usage?.cost_uusd)?result.usage.cost_uusd:null,cost_uusd:costFromUsage(route,usage),status:"completed"}};
  }
  async reconcile({ providerRequestId, route, signal }) {
    if (!this.apiKey) return {kind:"unknown",message:"OpenAI is not configured."};
    if (!providerRequestId || !route?.pricing) return {kind:"unknown",message:"A stored OpenAI response ID and pricing snapshot are required for reconciliation."};
    let response;
    try { response=await this.fetch(`${this.baseUrl}/responses/${encodeURIComponent(providerRequestId)}`,{method:"GET",signal:timeoutSignal(signal,this.timeoutMs),headers:{Authorization:`Bearer ${this.apiKey}`}}); }
    catch { return {kind:"unknown",message:"OpenAI response lookup failed; the reservation remains pending."}; }
    if (!response.ok) return {kind:"unknown",message:`OpenAI response lookup returned HTTP ${response.status}; execution status is unresolved.`};
    const text=await readLimitedText(response,Number(process.env.AEGIS_MAX_PROVIDER_RESPONSE_BYTES||4_000_000),this.name);
    let result;try{result=JSON.parse(text);}catch{return {kind:"unknown",message:"OpenAI returned an invalid reconciliation response."};}
    if (result.status!=="completed"||!result.usage) return {kind:"unknown",message:`OpenAI response is ${result.status??"missing a status or usage"}; execution status is unresolved.`};
    const usage={input_tokens:result.usage.input_tokens??0,output_tokens:result.usage.output_tokens??0};
    return {kind:"usage",usage:{...usage,model:route.alias,route,cost_uusd:costFromUsage(route,usage),provider_cost_uusd:Number.isSafeInteger(result.usage.cost_uusd)?result.usage.cost_uusd:null,status:"completed"}};
  }
  async *stream({ route, messages, prompt, maxTokens, signal }) {
    if (!this.apiKey) throw new ProviderError("OpenAI is not configured.",{provider:this.name,outcomeUnknown:false});
    let response;
    try { response=await this.fetch(`${this.baseUrl}/responses`,{method:"POST",signal:timeoutSignal(signal,this.timeoutMs),headers:{Authorization:`Bearer ${this.apiKey}`,"Content-Type":"application/json"},body:JSON.stringify({model:route.model,input:messages??[{role:"user",content:prompt}],max_output_tokens:maxTokens,store:true,stream:true})}); }
    catch { throw new ProviderError(signal?.aborted?"OpenAI response was cancelled; usage must be reconciled.":"OpenAI stream connection failed.",{provider:this.name,retryable:!signal?.aborted,outcomeUnknown:true,code:signal?.aborted?"client_cancelled":"provider_connection_error"}); }
    if(!response.ok||!response.body)throw new ProviderError(`OpenAI returned HTTP ${response.status}.`,{provider:this.name,status:response.status,retryable:response.status===429||response.status>=500,outcomeUnknown:response.status>=500});
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="";yield {type:"meta",provider_request_id:response.headers.get("x-request-id")};
    try{
      while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value??new Uint8Array(),{stream:!done});const blocks=buffer.split(/\r?\n\r?\n/);buffer=blocks.pop()??"";for(const block of blocks){const dataLine=block.match(/^data:\s*(.+)$/m)?.[1];if(!dataLine)continue;let event;try{event=JSON.parse(dataLine);}catch{continue;}if(event.type==="response.created"&&event.response?.id)yield {type:"meta",provider_request_id:event.response.id};if(event.type==="response.output_text.delta"&&event.delta)yield {type:"delta",text:event.delta};if(event.type==="response.completed"&&event.response?.usage){const usage={input_tokens:event.response.usage.input_tokens??0,output_tokens:event.response.usage.output_tokens??0};yield {type:"meta",provider_request_id:event.response.id};yield {type:"usage",usage:{...usage,model:route.alias,route,cost_uusd:costFromUsage(route,usage),provider_cost_uusd:Number.isSafeInteger(event.response.usage.cost_uusd)?event.response.usage.cost_uusd:null,status:"completed"}};}if(event.type==="response.failed"||event.type==="error")throw new ProviderError("OpenAI response stream failed.",{provider:this.name,retryable:false,outcomeUnknown:true});}if(done)break;}
    }finally{reader.releaseLock();}
    yield {type:"done"};
  }
}

export class AnthropicAdapter extends ProviderAdapter {
  constructor({ apiKey, baseUrl = "https://api.anthropic.com/v1", fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    super("anthropic");this.apiKey = apiKey; this.baseUrl = baseUrl.replace(/\/$/, ""); this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async invoke({ route, prompt, messages = [{ role: "user", content: prompt }], maxTokens, signal, onProviderRequestId }) {
    if (!this.apiKey) throw new ProviderError("Anthropic is not configured.", { provider: this.name, outcomeUnknown: false });
    const { result, requestId } = await jsonRequest({ provider: this.name, url: `${this.baseUrl}/messages`, apiKey: this.apiKey, fetchImpl: this.fetch, timeoutMs: this.timeoutMs, signal, onProviderRequestId, bearer:false, headers: { "anthropic-version": "2023-06-01", "x-api-key": this.apiKey }, body: { model: route.model, messages, max_tokens: maxTokens } });
    const usage = { input_tokens: result.usage?.input_tokens ?? 0, output_tokens: result.usage?.output_tokens ?? 0 };
    return { kind: "success", response: result.content?.filter(x => x.type === "text").map(x => x.text).join("") ?? "", provider_request_id: result.id ?? requestId, upstream_request_id:requestId, usage: { ...usage, model: route.alias, route, provider_cost_uusd: Number.isSafeInteger(result.usage?.cost_uusd) ? result.usage.cost_uusd : null, cost_uusd: costFromUsage(route, usage), status: "completed" } };
  }
  async reconcile({ providerRequestId }) {
    return { kind:"unknown",message:providerRequestId
      ? "Anthropic Messages does not expose a retrieve-by-message endpoint; use provider usage logs or manual reconciliation."
      : "Anthropic did not return a message ID before the gateway lost the result." };
  }
  async *stream({ route, prompt, messages = [{ role: "user", content: prompt }], maxTokens, signal }) {
    if (!this.apiKey) throw new ProviderError("Anthropic is not configured.", { provider: this.name, outcomeUnknown: false });
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/messages`, { method: "POST", signal: timeoutSignal(signal, this.timeoutMs), headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body: JSON.stringify({ model: route.model, messages, max_tokens: maxTokens, stream: true }) });
    } catch { throw new ProviderError("Anthropic stream connection failed.", { provider: this.name, retryable: true, outcomeUnknown: true }); }
    if (!response.ok || !response.body) throw new ProviderError(`Anthropic returned HTTP ${response.status}.`, { provider: this.name, status: response.status, retryable: response.status === 429 || response.status >= 500, outcomeUnknown: response.status >= 500 });
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let usage = { input_tokens: 0, output_tokens: 0 };
    try {
      while (true) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const eventName = block.match(/^event:\s*(.+)$/m)?.[1]; const dataLine = block.match(/^data:\s*(.+)$/m)?.[1]; if (!dataLine) continue;
          let event; try { event = JSON.parse(dataLine); } catch { continue; }
          if (eventName === "content_block_delta" && event.delta?.text) yield { type: "delta", text: event.delta.text };
          if (eventName === "message_start") {
            if(event.message?.id)yield {type:"meta",provider_request_id:event.message.id};
            usage.input_tokens = event.message?.usage?.input_tokens ?? usage.input_tokens;
          }
          if (eventName === "message_delta") usage.output_tokens = event.usage?.output_tokens ?? usage.output_tokens;
        }
        if (done) break;
      }
    } finally { reader.releaseLock(); }
    yield { type: "usage", usage: { ...usage, model: route.alias, route, cost_uusd: costFromUsage(route, usage), status: "completed" } };
    yield { type: "done" };
  }
}

export function createProviderRegistry({ env = process.env, fetchImpl = fetch, includeMock = false } = {}) {
  const providers = new Map();
  if (includeMock) providers.set("mock", new MockProvider());
  if (env.OPENAI_API_KEY) providers.set("openai", env.OPENAI_API_MODE === "responses"
    ? new OpenAIResponsesAdapter({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, fetchImpl })
    : new OpenAIAdapter({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, fetchImpl }));
  if (env.ANTHROPIC_API_KEY) providers.set("anthropic", new AnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL, fetchImpl }));
  return providers;
}
