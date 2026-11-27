const values=new Map();
const histograms=new Map();
const gauges=new Map();
let tracer={startActiveSpan:async(_name,_options,fn)=>fn({setAttribute(){},setStatus(){},recordException(){},end(){}})};
let otelMetrics=null;
let contextApi=null;
let propagationApi=null;

function labelKey(labels={}) { return Object.entries(labels).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"=\""+String(v).replaceAll("\\","\\\\").replaceAll('"','\\"')+"\"").join(","); }
function metricKey(name,labels) { return name+"{"+labelKey(labels)+"}"; }

export const gatewayMetrics={
  increment(name,labels={}) { const key=metricKey(name,labels); values.set(key,(values.get(key)??0)+1); otelMetrics?.counters.get(name)?.add(1,labels); },
  gauge(name,value,labels={}) { gauges.set(metricKey(name,labels),{name,value,labels}); },
  observe(name,value,labels={}) { const key=metricKey(name,labels); const data=histograms.get(key)??{count:0,sum:0,buckets:new Map()}; data.count++;data.sum+=value; for(const bucket of [5,10,25,50,100,250,500,1000,2500,5000,10000]) if(value<=bucket)data.buckets.set(bucket,(data.buckets.get(bucket)??0)+1);histograms.set(key,data);otelMetrics?.histograms.get(name)?.record(value,labels); },
  renderPrometheus() {
    const lines=["# HELP aegis_gateway_requests_total Requests processed by the gateway.","# TYPE aegis_gateway_requests_total counter"];
    for(const [key,value] of values) lines.push(key+" "+value);
    for(const [key,item] of gauges) lines.push(key+" "+item.value);
    for(const [key,data] of histograms) {
      const match=/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{(.*)\}$/.exec(key);if(!match)continue;
      for(const [bucket,count] of data.buckets) lines.push(match[1]+"_bucket{"+(match[2]?match[2]+",":"")+"le=\""+bucket+"\"} "+count);
      lines.push(match[1]+"_bucket{"+(match[2]?match[2]+",":"")+"le=\"+Inf\"} "+data.count);
      lines.push(match[1]+"_sum{"+match[2]+"} "+data.sum);
      lines.push(match[1]+"_count{"+match[2]+"} "+data.count);
    }
    return lines.join("\n")+"\n";
  }
};

export async function initializeTelemetry(env=process.env) {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return { enabled:false };
  const [{trace,metrics,context,propagation,SpanStatusCode},{NodeSDK},{OTLPTraceExporter},{OTLPMetricExporter},{PeriodicExportingMetricReader}]=await Promise.all([
    import("@opentelemetry/api"),import("@opentelemetry/sdk-node"),import("@opentelemetry/exporter-trace-otlp-proto"),import("@opentelemetry/exporter-metrics-otlp-proto"),import("@opentelemetry/sdk-metrics")
  ]);
  const base=(env.OTEL_EXPORTER_OTLP_ENDPOINT??"http://localhost:4318").replace(/\/$/,"");
  const headers=Object.fromEntries((env.OTEL_EXPORTER_OTLP_HEADERS??"").split(",").filter(Boolean).map(pair=>{const i=pair.indexOf("=");return i<0?[pair,""]:[pair.slice(0,i),decodeURIComponent(pair.slice(i+1))];}));
  const sdkCounters=new Map(),sdkHistograms=new Map();
  const sdk=new NodeSDK({
    serviceName:env.OTEL_SERVICE_NAME||"aegis-ai-gateway",
    traceExporter:new OTLPTraceExporter({url:env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT||base+"/v1/traces",headers}),
    metricReader:new PeriodicExportingMetricReader({exporter:new OTLPMetricExporter({url:env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT||base+"/v1/metrics",headers})})
  });
  await sdk.start();
  tracer=trace.getTracer("aegis-ai-gateway","1.0.0");
  contextApi=context;
  propagationApi=propagation;
  const meter=metrics.getMeter("aegis-ai-gateway","1.0.0");
  for(const name of ["aegis_gateway_requests_total","aegis_gateway_responses_total","aegis_budget_denials_total","aegis_provider_errors_total","aegis_provider_cost_mismatch_total","aegis_reconciliation_pending_total"]) sdkCounters.set(name,meter.createCounter(name));
  for(const name of ["aegis_gateway_overhead_ms","aegis_provider_latency_ms"]) sdkHistograms.set(name,meter.createHistogram(name,{unit:"ms"}));
  for(const name of ["aegis_reconciliation_backlog","aegis_reconciliation_oldest_age_seconds","aegis_outbox_backlog"]){
    meter.createObservableGauge(name).addCallback(observer=>{for(const item of gauges.values())if(item.name===name)observer.observe(item.value,item.labels);});
  }
  otelMetrics={counters:sdkCounters,histograms:sdkHistograms};
  return {enabled:true,shutdown:()=>sdk.shutdown(),SpanStatusCode};
}

export function runInRequestContext(headers,work) {
  if(!contextApi||!propagationApi)return work();
  const carrier={get:(source,key)=>source[key.toLowerCase()],keys:source=>Object.keys(source)};
  const extracted=propagationApi.extract(contextApi.active(),headers,carrier);
  return contextApi.with(extracted,work);
}

export async function inSpan(name,attributes,work) {
  return tracer.startActiveSpan(name,{attributes},async span=>{
    try{return await work(span);}
    catch(error){span.recordException?.({name:error?.name??"Error"});span.setStatus?.({code:2});throw error;}
    finally{span.end?.();}
  });
}
