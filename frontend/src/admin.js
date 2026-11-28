const escapeHtml=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const views=["tenants","members","keys","routes","quotas","pricing","providers","reconciliation","audit"];
const titles={tenants:"Tenants",members:"Users & access",keys:"API keys",routes:"Routes & policies",quotas:"Budgets & quotas",pricing:"Pricing versions",providers:"Provider health",reconciliation:"Reconciliation",audit:"Audit events"};
const endpoint={tenants:"listTenants",members:"listMembers",keys:"listApiKeys",routes:"listRoutingConfigs",quotas:"listQuotas",pricing:"listPricing",providers:"getProviderHealth",reconciliation:"listReconciliation",audit:"listAuditEvents"};

function reconciliationCard(row){
  const reservationId=escapeHtml(row.reservation_id);
  return `<article class="panel admin-record"><div><p class="section-label">DEAD LETTER · ${escapeHtml(row.attempts)} ATTEMPTS</p><h3>Reservation ${reservationId}</h3><p>${escapeHtml(row.reason)}</p><p class="quiet-copy">Resolve only after checking authoritative provider records. Add a safe evidence reference; do not paste prompts, credentials, or provider response content.</p></div><form class="admin-form" data-reconcile-resolution data-reservation-id="${reservationId}"><div class="admin-form-grid"><label>Outcome<select class="control" name="outcome" data-reconcile-outcome><option value="settled">Provider usage is confirmed</option><option value="not_executed">Provider confirms no execution</option></select></label><label>Evidence reference<input class="control" name="evidence_ref" pattern="[A-Za-z0-9][A-Za-z0-9._:/#-]{2,499}" maxlength="500" required aria-describedby="evidence-guidance"></label><label class="form-span">Reason<textarea class="control" name="reason" minlength="3" maxlength="500" rows="2" required></textarea></label></div><p id="evidence-guidance" class="field-help">Use a provider receipt or console record ID. Avoid URLs with query strings and never include secrets.</p><div data-reconcile-usage><h4>Verified usage</h4><div class="admin-form-grid"><label>Provider request ID<input class="control" name="provider_request_id" maxlength="256" required></label><label>Input tokens<input class="control" name="input_tokens" type="number" min="0" step="1" required></label><label>Output tokens<input class="control" name="output_tokens" type="number" min="0" step="1" required></label><label>Calculated cost (uUSD)<input class="control" name="cost_uusd" type="number" min="0" step="1" required></label><label>Provider reported cost (uUSD, optional)<input class="control" name="provider_cost_uusd" type="number" min="0" step="1"></label><label>Usage status<select class="control" name="status"><option value="completed">Completed</option><option value="partial">Partial</option></select></label></div></div><button class="button button-primary button-small" type="submit">Record resolution</button></form></article>`;
}

function rowsHtml(rows,columns){
  if(!rows?.length)return '<p class="empty-state">Nothing to show yet.</p>';
  return `<div class="table-scroll"><table class="data-table"><thead><tr>${columns.map(([label])=>`<th scope="col">${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(([,key])=>`<td>${escapeHtml(typeof key==="function"?key(row):row[key])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function attachAdmin({adapter,mode}){
  const root=document.querySelector("#admin-console");
  if(!root)return;
  const status=root.querySelector("[data-admin-status]");
  const content=root.querySelector("[data-admin-content]");
  const tabs=root.querySelector("[data-admin-tabs]");
  let active="tenants";
  let cached={};
  let freshKey=null;
  const setStatus=(message,kind="info")=>{status.textContent=message;status.dataset.kind=kind;};

  async function load(view=active){
    active=view;
    tabs.querySelectorAll("[data-admin-view]").forEach(button=>{const on=button.dataset.adminView===view;button.classList.toggle("active",on);button.setAttribute("aria-selected",String(on));});
    if(mode!=="api"||typeof adapter?.[endpoint[view]]!=="function"){
      content.innerHTML='<div class="panel configuration-state"><div class="configuration-icon">A</div><div><p class="section-label">ADMIN SESSION REQUIRED</p><h2>Connect the gateway control plane</h2><p>This screen needs an authenticated administrator session from the host application. It never reads a credential from local storage or a URL.</p></div></div>';
      setStatus("Administration is unavailable in fixture mode.","warning");return;
    }
    setStatus(`Loading ${titles[view].toLowerCase()}…`);
    try{cached[view]=await adapter[endpoint[view]]();render(view,cached[view]);setStatus(`${titles[view]} loaded.`);}
    catch(error){content.innerHTML=`<div class="panel configuration-state"><div><p class="section-label">ACCESS CHECK</p><h2>${escapeHtml(error.message)}</h2><p>Use a live, administrator-authorized session to read or change this workspace.</p></div></div>`;setStatus("Control-plane request failed.","error");}
  }

  function render(view,data){
    const head=`<div class="admin-section-head"><div><p class="section-label">CONTROL PLANE</p><h2>${titles[view]}</h2></div><button class="quiet-button" type="button" data-admin-refresh>Refresh</button></div>`;
    const tenantOptions=(data.tenants??[]).map(item=>"<option value=\""+escapeHtml(item.tenant_id)+"\">"+escapeHtml(item.tenant_id)+" · "+escapeHtml(item.name)+"</option>").join("")||"<option value=\"\" disabled>No tenants available</option>";
    if(view==="tenants")content.innerHTML=head+"<form class=\"panel admin-form\" data-admin-form=\"tenant\"><h3>Add tenant</h3><div class=\"admin-form-grid\"><label>Tenant ID<input class=\"control\" name=\"tenant_id\" required pattern=\"[a-zA-Z0-9_-]+\" maxlength=\"80\"></label><label>Name<input class=\"control\" name=\"name\" required></label><label>Monthly limit (uUSD)<input class=\"control\" name=\"monthly_limit_uusd\" type=\"number\" min=\"0\" step=\"1\" required></label><label>Reason<input class=\"control\" name=\"reason\" required></label></div><button class=\"button button-primary button-small\">Create tenant</button></form><form class=\"panel admin-form\" data-admin-form=\"tenant-owner\"><h3>Assign first tenant owner</h3><p>This is available to platform administrators for tenants with no active members.</p><div class=\"admin-form-grid\"><label>Tenant<select class=\"control\" name=\"tenant_id\" required>"+tenantOptions+"</select></label><label>Owner user ID<input class=\"control\" name=\"user_id\" required></label><label>Email<input class=\"control\" name=\"email\" type=\"email\" required></label><label>Name<input class=\"control\" name=\"display_name\" required></label><label>Reason<input class=\"control\" name=\"reason\" required></label></div><button class=\"button button-secondary button-small\" "+((data.tenants??[]).length?"":"disabled")+">Assign first owner</button></form>"+rowsHtml(data.tenants,[ ["Tenant ID","tenant_id"],["Name","name"],["Monthly limit (uUSD)","monthly_limit_uusd"],["Status",r=>r.active?"Active":"Disabled"] ]);
    else if(view==="members")content.innerHTML=head+`<form class="panel admin-form" data-admin-form="member"><h3>Add or update member</h3><div class="admin-form-grid"><label>User ID<input class="control" name="user_id" required></label><label>Email<input class="control" name="email" type="email" required></label><label>Name<input class="control" name="display_name" required></label><label>Role<select class="control" name="role"><option>viewer</option><option>operator</option><option>admin</option><option>owner</option></select></label><label>Reason<input class="control" name="reason" required></label></div><button class="button button-primary button-small">Save member</button></form>`+rowsHtml(data.members,[ ["User ID","user_id"],["Email","email"],["Name","display_name"],["Role","role"],["Status",r=>r.active?"Active":"Disabled"] ]);
    else if(view==="keys")content.innerHTML=head+`<form class="panel admin-form" data-admin-form="key"><h3>Create API key</h3><div class="admin-form-grid"><label>Name<input class="control" name="name" required></label><label>Member user ID<input class="control" name="user_id" placeholder="Use your own member ID"></label><label>Environment<select class="control" name="environment"><option value="live">Live</option><option value="test">Test</option></select></label><label>Expires at<input class="control" name="expires_at" type="datetime-local"></label><label>Scopes (comma separated)<input class="control" name="scopes" value="gateway:invoke,usage:read" required></label><label>Reason<input class="control" name="reason" required></label></div><button class="button button-primary button-small">Create key</button><div class="one-time-key" ${freshKey?"":"hidden"}><label>Copy this key now. It cannot be displayed again.<textarea class="control" readonly rows="3" data-key-value>${escapeHtml(freshKey??"")}</textarea></label><button class="quiet-button" type="button" data-copy-key>Copy key</button><button class="quiet-button" type="button" data-dismiss-key>Dismiss</button></div></form><form class="panel admin-form" data-key-actions><h3>Rotate or revoke a key</h3><div class="admin-form-grid"><label>Active key<select class="control" name="key_id" required>${(data.keys??[]).filter(r=>!r.revoked_at).map(r=>`<option value="${escapeHtml(r.key_id)}">${escapeHtml(r.name)} · ${escapeHtml(r.key_prefix)}</option>`).join("")}</select></label><label>Reason<input class="control" name="reason" required></label></div><button class="button button-secondary button-small" type="button" data-key-do="rotate">Rotate</button> <button class="button button-danger button-small" type="button" data-key-do="revoke">Revoke</button></form>`+rowsHtml(data.keys,[ ["Name","name"],["Prefix","key_prefix"],["Member","user_id"],["Scopes",r=>r.scopes?.join(", ")],["Created","created_at"],["Expires","expires_at"],["Last used","last_used_at"],["Revoked",r=>r.revoked_at?"Yes":"No"] ]);
    else if(view==="routes")content.innerHTML=head+
      '<form class="panel admin-form" data-admin-form="route"><h3>Draft routing policy</h3><label>Configuration JSON<textarea class="control" name="config" rows="10" required>{"aliases":{"example-model":[{"provider":"openai","model":"gpt-4.1-mini","priority":1,"weight":100,"region":"global","max_cost_uusd":1000000,"max_latency_ms":3000}]},"tenants":{}}</textarea></label><label>Reason<input class="control" name="reason" required></label><button class="button button-primary button-small">Save draft</button></form>'+
      '<div class="admin-stack">'+((data.configurations??[]).map(row=>'<article class="panel admin-record"><div><p class="section-label">VERSION '+escapeHtml(row.version_id)+'</p><h3>'+escapeHtml(row.state)+'</h3><p>'+escapeHtml(row.reason)+'</p><pre>'+escapeHtml(JSON.stringify(row.config,null,2))+'</pre></div>'+
        (row.state==="draft"?'<form data-admin-form="publish" data-version="'+escapeHtml(row.version_id)+'"><label>Publish reason<input class="control" name="reason" required></label><button class="button button-secondary button-small">Publish</button></form>':"")+
        (row.state==="rolled_back"&&row.tenant_id?'<form data-admin-form="route-rollback" data-version="'+escapeHtml(row.version_id)+'"><p class="quiet-copy">Create a new version using this saved configuration.</p><label>Rollback reason<input class="control" name="reason" required minlength="3"></label><button class="button button-secondary button-small">Roll back to this version</button></form>':"")+
      '</article>').join("")||'<p class="empty-state">No route versions yet.</p>')+'</div>';
    else if(view==="quotas")content.innerHTML=head+`<form class="panel admin-form" data-admin-form="quota"><h3>Add workspace, user, or API key quota</h3><p class="field-help">Leave user and API key blank to apply the quota across this workspace. In the current data model, one tenant is one workspace.</p><div class="admin-form-grid"><label>Period<select class="control" name="period"><option>day</option><option>month</option></select></label><label>User ID (optional)<input class="control" name="principal_id"></label><label>API key ID (optional)<input class="control" name="api_key_id"></label><label>Request limit<input class="control" name="request_limit" type="number" min="0"></label><label>Token limit<input class="control" name="token_limit" type="number" min="0"></label><label>Cost limit (uUSD)<input class="control" name="cost_limit_uusd" type="number" min="0"></label><label>Concurrency limit<input class="control" name="concurrency_limit" type="number" min="0"></label><label>Reason<input class="control" name="reason" required></label></div><button class="button button-primary button-small">Create quota</button></form>`+rowsHtml(data.policies,[ ["ID","quota_id"],["Scope",r=>r.principal_id?"User":r.api_key_id?"API key":"Workspace"],["Period","period"],["User","principal_id"],["API key","api_key_id"],["Requests","request_limit"],["Tokens","token_limit"],["Cost (uUSD)","cost_limit_uusd"],["Concurrency","concurrency_limit"],["Active",r=>r.active?"Yes":"No"] ]);
    else if(view==="pricing")content.innerHTML=head+`<form class="panel admin-form" data-admin-form="pricing"><h3>Publish a pricing version</h3><div class="admin-form-grid"><label>Provider<input class="control" name="provider" required></label><label>Model<input class="control" name="model" required></label><label>Region<input class="control" name="region" value="global" required></label><label>Unit<select class="control" name="unit"><option>token</option><option>request</option><option>image</option><option>second</option></select></label><label>Input USD / million<input class="control" name="input_usd_per_million" type="number" min="0" step="0.000001" value="0"></label><label>Output USD / million<input class="control" name="output_usd_per_million" type="number" min="0" step="0.000001" value="0"></label><label>Version<input class="control" name="version" required></label><label>Effective at<input class="control" name="effective_at" type="datetime-local" required></label><label>Reason<input class="control" name="reason" required></label></div><button class="button button-primary button-small">Publish pricing</button></form>`+rowsHtml(data.versions,[ ["Provider","provider"],["Model","model"],["Region","region"],["Unit","unit"],["Input USD/M","input_usd_per_million"],["Output USD/M","output_usd_per_million"],["Version","version"],["Effective","effective_at"] ]);
    else if(view==="providers")content.innerHTML=head+rowsHtml(data.providers,[ ["Provider","name"],["Status","status"] ]);
    else if(view==="reconciliation"){
      const unresolved=(data.dead_letters??[]).filter(row=>!row.resolved_at);
      const resolved=(data.dead_letters??[]).filter(row=>row.resolved_at);
      content.innerHTML=head+`<h3>Open cases</h3>`+rowsHtml(data.jobs,[ ["Request","request_id"],["Provider","provider"],["Provider request","provider_request_id"],["State","state"],["Attempts","attempts"],["Reserved (uUSD)","quote_uusd"],["Last error","last_error"] ])+`<h3>Dead letters</h3>`+(unresolved.map(reconciliationCard).join("")||'<p class="empty-state">No unresolved dead letters.</p>')+`<h3>Resolved cases</h3>`+rowsHtml(resolved,[ ["Reservation","reservation_id"],["Reason","reason"],["Attempts","attempts"],["Resolved by","resolved_by"],["Resolved at","resolved_at"] ]);
    }
    else content.innerHTML=head+rowsHtml(data.events,[ ["Time","created_at"],["Actor","actor_id"],["Action","action"],["Reason","reason"],["Target","target_type"],["Correlation ID","correlation_id"] ]);
  }

  async function resolveDeadLetter(form){
    const values=Object.fromEntries(new FormData(form).entries());
    const payload={outcome:values.outcome,evidence_ref:values.evidence_ref,reason:values.reason};
    if(values.outcome==="settled"){
      payload.provider_request_id=values.provider_request_id;
      payload.input_tokens=Number(values.input_tokens);
      payload.output_tokens=Number(values.output_tokens);
      payload.cost_uusd=Number(values.cost_uusd);
      payload.provider_cost_uusd=values.provider_cost_uusd===""?null:Number(values.provider_cost_uusd);
      payload.status=values.status;
    }
    try{
      await adapter.resolveReconciliation(form.dataset.reservationId,payload);
      await load("reconciliation");
      setStatus(values.outcome==="settled"?"Verified usage settled and recorded in the audit trail.":"Reservation released after provider non-execution was verified.","success");
    }catch(error){setStatus(error.message,"error");}
  }

  async function submit(form){
    const values=Object.fromEntries(new FormData(form).entries());
    const number=(key)=>values[key]===""?null:Number(values[key]);
    try{
      if(form.dataset.adminForm==="tenant")await adapter.createTenant({tenant_id:values.tenant_id,name:values.name,monthly_limit_uusd:Number(values.monthly_limit_uusd),reason:values.reason});
      if(form.dataset.adminForm==="tenant-owner")await adapter.bootstrapTenantOwner(values.tenant_id,{user_id:values.user_id,email:values.email,display_name:values.display_name,reason:values.reason});
      if(form.dataset.adminForm==="member")await adapter.createMember(values);
      if(form.dataset.adminForm==="key"){
        const created=await adapter.createApiKey({...values,scopes:values.scopes.split(",").map(s=>s.trim()).filter(Boolean),expires_at:values.expires_at?new Date(values.expires_at).toISOString():null});
        freshKey=created.key;cached.keys=await adapter.listApiKeys();render("keys",cached.keys);setStatus("API key created. Copy it now; the server will never show it again.","warning");return;
      }
      if(form.dataset.adminForm==="route")await adapter.createRoutingDraft({config:JSON.parse(values.config),reason:values.reason});
      if(form.dataset.adminForm==="quota")await adapter.createQuota({...values,principal_id:values.principal_id||null,api_key_id:values.api_key_id||null,request_limit:number("request_limit"),token_limit:number("token_limit"),cost_limit_uusd:number("cost_limit_uusd"),concurrency_limit:number("concurrency_limit")});
      if(form.dataset.adminForm==="pricing")await adapter.createPricing({...values,input_usd_per_million:Number(values.input_usd_per_million),output_usd_per_million:Number(values.output_usd_per_million),effective_at:new Date(values.effective_at).toISOString()});
      if(form.dataset.adminForm==="publish")await adapter.publishRoutingConfig(form.dataset.version,values.reason);
      if(form.dataset.adminForm==="route-rollback")await adapter.rollbackRoutingConfig(form.dataset.version,values.reason);
      if(form.dataset.adminForm==="route-rollback")setStatus("Rollback published as a new routing version and recorded in the audit trail.","success");
      else if(form.dataset.adminForm!=="key")setStatus("Change saved and recorded in the audit trail.","success");
      await load(active);
    }catch(error){setStatus(error.message,"error");}
  }

  tabs.addEventListener("click",event=>{const button=event.target.closest("[data-admin-view]");if(button)load(button.dataset.adminView);});
  root.addEventListener("click",async event=>{
    if(event.target.closest("[data-admin-refresh]")){load(active);return;}
    if(event.target.closest("[data-copy-key]")){const field=content.querySelector("[data-key-value]");try{await navigator.clipboard.writeText(field.value);setStatus("One-time API key copied.","success");}catch{field.focus();field.select();setStatus("Select and copy the one-time key.","warning");}}
    if(event.target.closest("[data-dismiss-key]")){freshKey=null;render("keys",cached.keys??{keys:[]});setStatus("One-time key removed from this page.");}
    const keyAction=event.target.closest("[data-key-do]");
    if(keyAction){const form=root.querySelector("[data-key-actions]");if(!form.reportValidity())return;const keyId=new FormData(form).get("key_id");const reason=new FormData(form).get("reason");try{if(keyAction.dataset.keyDo==="rotate"){const rotated=await adapter.rotateApiKey(keyId,reason);freshKey=rotated.key;setStatus("Key rotated. Copy the new key now; the previous key is revoked.","warning");}else{await adapter.revokeApiKey(keyId,reason);freshKey=null;setStatus("API key revoked.","success");}cached.keys=await adapter.listApiKeys();render("keys",cached.keys);}catch(error){setStatus(error.message,"error");}}
  });
  root.addEventListener("change",event=>{
    const outcome=event.target.closest("[data-reconcile-outcome]");
    if(!outcome)return;
    const form=outcome.closest("[data-reconcile-resolution]");
    const usage=form.querySelector("[data-reconcile-usage]");
    const enabled=outcome.value==="settled";
    usage.hidden=!enabled;
    usage.querySelectorAll("[required]").forEach(input=>{input.required=enabled;});
  });
  root.addEventListener("submit",event=>{
    const resolution=event.target.closest("[data-reconcile-resolution]");
    if(resolution){event.preventDefault();if(resolution.reportValidity())resolveDeadLetter(resolution);return;}
    const form=event.target.closest("[data-admin-form]");
    if(form){event.preventDefault();if(form.reportValidity())submit(form);}
  });
  document.addEventListener("click",event=>{
    const jump=event.target.closest("[data-admin-open]");
    if(jump)requestAnimationFrame(()=>load(jump.dataset.adminOpen));
    else if(event.target.closest('[data-page="admin"]'))requestAnimationFrame(()=>load("tenants"));
  });
  if(!document.querySelector("#page-admin")?.hidden)load("tenants");
  return {load};
}
