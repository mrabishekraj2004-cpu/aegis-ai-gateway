import { createHttpAdapter } from "./api.js";
import { createSimulatedAdapter } from "./fixtures.js";

const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(window.location.search);
const runtimeConfig = window.AEGIS_CONFIG ?? {};
const mode = params.get("mode") === "api" ? "api" : "simulated";
const localDemoMode = mode === "api" && runtimeConfig.localDemoMode === true;
const demoTenants = [
  { id: "aster", name: "Aster Labs" },
  { id: "juniper", name: "Juniper Health" },
  { id: "budget", name: "Budget Demo — $0.34 request cap" }
].filter(tenant => typeof runtimeConfig.demoTokens?.[tenant.id] === "string" && runtimeConfig.demoTokens[tenant.id]);
let selectedTenant = localDemoMode && demoTenants.some(tenant => tenant.id === "budget") ? "budget" : "aster";
const getAccessToken = async () => {
  if (localDemoMode) return runtimeConfig.demoTokens?.[selectedTenant] ?? null;
  return typeof runtimeConfig.getAccessToken === "function"
    ? runtimeConfig.getAccessToken()
    : runtimeConfig.accessToken || null;
};
const adapter = mode === "api"
  ? createHttpAdapter({ baseUrl: runtimeConfig.apiBaseUrl ?? "", getAccessToken, localDemoMode })
  : createSimulatedAdapter({ delayMs: 0 });
let overview = null;
let busy = false;
let toastTimer;
let currentPage = "overview";
let currentAuthView = "login";
const profileStorageKey = "aegis-preview-profile-v1";
const preferencesStorageKey = "aegis-preview-preferences-v1";
const defaultProfile = { name: "Aegis Operator", email: "operator@asterlabs.test" };

const currency = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0) / 1_000_000);
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
const available = budget => budget.limit_uusd - budget.settled_uusd - budget.reserved_uusd;
const remainingLabel = budget => currency(available(budget));

function setStatus(message) {
  $("#live-status").textContent = message;
}

function setPageAlert(message) {
  const alert = $("#page-alert");
  alert.textContent = message;
  alert.hidden = !message;
}

function renderMode() {
  const simulated = mode === "simulated";
  $("#mode-badge").textContent = simulated ? "Fixture mode" : "Gateway API";
  $("#mode-label").textContent = simulated ? "Simulated fixtures" : localDemoMode ? "Local gateway demo" : "Gateway API mode";
  $("#mode-description").textContent = simulated
    ? "Synthetic fixtures only. No gateway or model is contacted."
    : localDemoMode
      ? "Local demo controls use bearer tokens; the gateway resolves tenant identity."
      : "Tenant identity comes from the authenticated API credential.";
  $("#tenant-control").hidden = !(simulated || (localDemoMode && demoTenants.length > 0));
  $("#api-tenant").hidden = simulated || localDemoMode;
  $("#scenario-fieldset").hidden = !(simulated || localDemoMode);
  $("#reset-button").hidden = !simulated;
  $("#storage-badge").hidden = simulated;
  $("#storage-badge").textContent = simulated ? "" : "Storage check pending";
  $("#fixture-mode-link").toggleAttribute("aria-current", simulated);
  $("#api-mode-link").toggleAttribute("aria-current", !simulated);
  $("#provider-note").textContent = simulated
    ? "Mock route only. No paid key or external model call."
    : localDemoMode
      ? "Live local gateway API with deterministic mock provider; no paid model key."
      : "Gateway API mode. Authentication is provided by the host app.";
  $("#mode-badge").innerHTML = `<span class="mode-dot"></span> ${simulated ? "Fixture mode" : "Gateway API"}`;
  if (localDemoMode) {
    const options = document.querySelectorAll(".scenario-option");
    options[0].querySelector("strong").textContent = "In-budget request";
    options[0].querySelector("small").textContent = "Normal $0.34 mock route";
    options[1].querySelector("strong").textContent = "Actual budget limit";
    options[1].querySelector("small").textContent = "Use Budget Demo; repeat after cap";
    options[2].querySelector("strong").textContent = "Provider failure";
    options[2].querySelector("small").textContent = "$0.34 stays reserved";
    $("#scenario-fieldset legend").textContent = "Local gateway demo controls";
  }
}

async function populateTenants() {
  const tenants = mode === "simulated"
    ? await adapter.listTenants()
    : localDemoMode ? demoTenants : [];
  if (!tenants.length) return;
  const select = $("#tenant-select");
  select.innerHTML = tenants.map(item => {
    const suffix = item.id === "budget" ? " - actual $0.34 cap" : localDemoMode ? " - local demo tenant" : " - synthetic fixture";
    return `<option value="${escape(item.id)}">${escape(item.name)}${suffix}</option>`;
  }).join("");
  select.value = selectedTenant;
  select.addEventListener("change", async event => {
    selectedTenant = event.target.value;
    clearOutcome();
    try {
      await refreshOverview();
      setPageAlert("");
      setStatus(`${overview?.tenantName ?? "Demo tenant"} selected. Its bearer credential resolves a separate budget and usage history.`);
    } catch (error) {
      setPageAlert(`Could not load this tenant from the selected mode: ${error.message}. No fixtures were loaded.`);
      setStatus(`Tenant overview unavailable. ${error.message}`);
    }
  });
}

function renderStorageMode(storageMode) {
  const labels = {
    postgres: "PostgreSQL storage",
    memory: "In-memory storage — not durable",
    unknown: "Storage mode unknown"
  };
  const label = labels[storageMode] ?? labels.unknown;
  const badge = $("#storage-badge");
  badge.hidden = false;
  badge.textContent = label;
  badge.classList.toggle("storage-memory", storageMode === "memory");
  badge.classList.toggle("storage-unknown", !labels[storageMode]);
  $("#mode-description").textContent = `${localDemoMode ? "Local demo controls are enabled. " : ""}Tenant identity comes from the bearer credential. ${label}.`;
}

function renderBudget() {
  if (!overview) return;
  const budget = overview.budget;
  const committed = budget.settled_uusd + budget.reserved_uusd;
  const progress = budget.limit_uusd > 0 ? Math.min(100, committed / budget.limit_uusd * 100) : 0;
  const entries = overview.entries ?? [];
  $("#available-amount").textContent = remainingLabel(budget);
  $("#settled-amount").textContent = currency(budget.settled_uusd);
  $("#reserved-amount").textContent = currency(budget.reserved_uusd);
  $("#committed-label").textContent = `${currency(committed)} committed`;
  $("#limit-label").textContent = currency(budget.limit_uusd);
  $("#budget-percent").textContent = `${progress.toFixed(1)}%`;
  $("#progress-fill").style.width = `${progress}%`;
  const bar = $("#budget-progress");
  bar.setAttribute("aria-valuemax", String(budget.limit_uusd));
  bar.setAttribute("aria-valuenow", String(committed));
  bar.setAttribute("aria-valuetext", `${currency(committed)} committed of ${currency(budget.limit_uusd)}`);
  $("#workspace-name").textContent = overview.tenantName;
  $("#workspace-name-heading").textContent = overview.tenantName.toUpperCase();
  $("#breadcrumb-workspace").textContent = overview.tenantName;
  $("#settings-workspace-name").textContent = overview.tenantName;
  $("#settings-budget-cap").textContent = `${currency(budget.limit_uusd)} / month`;
  $("#api-tenant").textContent = mode === "api" ? overview.tenantName : "";
  $("#usage-settled").textContent = currency(budget.settled_uusd);
  $("#usage-reserved").textContent = currency(budget.reserved_uusd);
  $("#usage-available").textContent = remainingLabel(budget);
  $("#usage-count").textContent = String(entries.length);
  if (budget.window_start && budget.window_end) {
    const start = new Date(budget.window_start);
    const end = new Date(new Date(budget.window_end).getTime() - 86_400_000);
    const fmt = date => date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const reset = `${new Date(budget.window_end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} UTC`;
    $("#period-label").textContent = `${fmt(start)} – ${fmt(end)} UTC`;
    $("#usage-window").textContent = `${fmt(start)} – ${fmt(end)} UTC`;
    $("#reset-date").textContent = reset;
  }
}

function renderUsage() {
  if (!overview) return;
  const entries = overview.entries ?? [];
  const box = $("#usage-table");
  $("#usage-count").textContent = String(entries.length);
  const activity = $("#overview-activity");
  if (activity) {
    activity.innerHTML = entries.length ? entries.slice(0, 4).map(entry => {
      const route = entry.route ?? {};
      return `<div class="activity-item"><span class="activity-icon" aria-hidden="true">↗</span><div class="activity-copy"><strong>${escape(entry.model ?? "demo-model")} <span class="route-target">· ${escape(route.model ?? "unknown route")}</span></strong><span>${escape(entry.request_id)}</span></div><div class="activity-cost">${currency(entry.cost_uusd)}<small>${escape(entry.created_at ?? "Completed")}</small></div></div>`;
    }).join("") : '<div class="activity-empty">No billable requests yet. Send your first request to begin.</div>';
  }
  if (!entries.length) {
    box.innerHTML = '<div class="empty-history">No billable requests yet. A successful request will appear here.</div>';
    return;
  }
  const rows = entries.map(entry => {
    const tokens = entry.total_tokens ?? Number(entry.input_tokens ?? 0) + Number(entry.output_tokens ?? 0);
    const route = entry.route ?? {};
    return `<tr>
      <td><button class="inline-link mono" type="button" data-request-id="${escape(entry.request_id)}" aria-label="View usage for ${escape(entry.request_id)}">${escape(entry.request_id)}</button></td>
      <td class="route">${escape(entry.model ?? "demo-model")} <span class="route-target">/ ${escape(route.model ?? "unknown model")}</span></td>
      <td class="hide-mobile">${tokens.toLocaleString("en-US")}</td>
      <td class="cost">${currency(entry.cost_uusd)}</td>
      <td><span class="completed">Completed</span></td>
      <td class="hide-mobile">${escape(entry.created_at ?? "")}</td>
    </tr>`;
  }).join("");
  box.innerHTML = `<div class="table-wrap"><table><caption>Billable usage history for ${escape(overview.tenantName)}</caption><thead><tr><th scope="col">Request ID</th><th scope="col">Selected route</th><th scope="col" class="hide-mobile">Tokens</th><th scope="col">Cost</th><th scope="col">Status</th><th scope="col" class="hide-mobile">Time</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  box.querySelectorAll("[data-request-id]").forEach(button => button.addEventListener("click", () => showUsageDetail(button.dataset.requestId)));
}

function clearOutcome() {
  $("#outcome-tag").textContent = "Ready";
  $("#outcome").innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">&#9671;</span><h3>Ready for a first request</h3><p>Choose a scenario and run it to see the route, response, budget, and usage record.</p></div>';
}

function renderLoading() {
  $("#latest-request").setAttribute("aria-busy", "true");
  $("#outcome-tag").textContent = "Processing";
  $("#outcome").innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Checking budget and routing request...</span></div>';
  setStatus("Request is loading. Checking budget and route.");
}

function finishLoading() {
  busy = false;
  $("#latest-request").setAttribute("aria-busy", "false");
  $("#submit-button").disabled = false;
  $("#submit-button").querySelector("span").textContent = "Run request";
}

function setTagAndResult(tag, html) {
  $("#outcome-tag").textContent = tag;
  $("#outcome").innerHTML = html;
}

function renderSuccess(result) {
  const usage = result.usage ?? {};
  const route = result.route ?? usage.route ?? {};
  const input = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const cost = Number(usage.cost_uusd ?? 0);
  const tokens = Number(usage.total_tokens ?? input + output);
  const routeLabel = `${route.provider ?? "provider"} / ${route.model ?? "selected model"}`;
  setTagAndResult("Completed", `<div class="result-panel success" role="status">
    <div class="result-head"><div><h3 class="result-title">Request completed</h3><p class="result-copy">The selected route returned a response and usage was settled.</p></div><span class="state-pill">200 Success</span></div>
    <hr class="divider"><div class="detail-grid">
      <div class="detail"><span>Request ID</span><strong><button class="inline-link mono" type="button" data-request-id="${escape(result.requestId)}">${escape(result.requestId)}</button></strong></div>
      <div class="detail"><span>Selected route</span><strong>${escape(routeLabel)}</strong></div>
      <div class="detail"><span>Settled cost</span><strong>${currency(cost)}</strong></div>
      <div class="detail"><span>Usage</span><strong>${input} input / ${output} output (${tokens} total)</strong></div>
    </div><p class="response-preview"><strong>Model response</strong><br>${escape(result.response)}</p></div>`);
  $("#outcome [data-request-id]").addEventListener("click", () => showUsageDetail(result.requestId));
  const currentBudget = overview?.budget ?? result.budget;
  const remaining = currentBudget ? remainingLabel(currentBudget) : "unavailable";
  setStatus(`Request completed. Route ${routeLabel}. Cost ${currency(cost)}. ${tokens} tokens recorded. Remaining budget ${remaining}.`);
}

function renderDenial(result) {
  const quote = Number(result.quote_uusd ?? 0);
  const remaining = Number(result.remaining_uusd ?? available(overview.budget));
  setTagAndResult("Denied", `<div class="result-panel denied" role="alert">
    <div class="result-head"><div><h3 class="result-title">Request denied: budget exceeded</h3><p class="result-copy">The ${currency(quote)} quote is above this tenant's ${currency(remaining)} available budget.</p></div><span class="state-pill">429 Denied</span></div>
    <hr class="divider"><div class="detail-grid">
      <div class="detail"><span>Request ID</span><strong class="mono">${escape(result.requestId)}</strong></div>
      <div class="detail"><span>Request quote</span><strong>${currency(quote)}</strong></div>
      <div class="detail"><span>Budget change</span><strong>None - ${currency(remaining)} remains</strong></div>
      <div class="detail"><span>Usage entry</span><strong>Not created</strong></div>
    </div><div class="callout"><span aria-hidden="true">!</span><span><strong>Provider was never called.</strong> Admission stopped this request before invocation. Budget and usage history are unchanged.</span></div>
  </div>`);
  setStatus(`Request denied because the ${currency(quote)} quote exceeds ${currency(remaining)} available. Provider was not called. Budget and usage history unchanged.`);
}

function renderFailure(result) {
  const reserved = result.reserved_uusd == null ? null : Number(result.reserved_uusd);
  const settlement = result.settlement_state ?? "reconcile_required";
  const pending = settlement === "reconcile_required" || settlement === "pending";
  const released = settlement === "released" || settlement === "no_charge";
  const settled = settlement === "settled" || settlement === "partial_usage_settled";
  const stateText = pending ? "pending reconciliation" : settlement;
  const outcomeTag = pending ? "Pending reconciliation" : released ? "Reservation released" : settled ? "Usage settled" : "Provider error";
  const reservationText = pending
    ? reserved == null ? "Reservation amount not provided by the API. Do not assume it was released." : `${currency(reserved)} remains reserved. It has not been charged or released.`
    : released ? "The API reports the reservation was released. Refresh the budget summary before another request."
      : settled ? "The API reports usage was settled. Check the usage history for the billable entry."
        : `The API reports settlement state: ${settlement}. Do not assume the reservation was released.`;
  setTagAndResult(outcomeTag, `<div class="result-panel failure" role="alert">
    <div class="result-head"><div><h3 class="result-title">Provider returned an error</h3><p class="result-copy">${escape(result.message ?? "The request failed before final usage was returned.")}</p></div><span class="state-pill">502 Provider error</span></div>
    <hr class="divider"><div class="detail-grid">
      <div class="detail"><span>Request ID</span><strong class="mono">${escape(result.requestId)}</strong></div>
      <div class="detail"><span>Provider call</span><strong>${result.providerCalled ? "Invoked" : "Not confirmed"}</strong></div>
      <div class="detail"><span>Settlement state</span><strong>${escape(stateText)}</strong></div>
      <div class="detail"><span>Usage entry</span><strong>Not created</strong></div>
    </div><div class="callout"><span aria-hidden="true">i</span><span><strong>${escape(reservationText)}</strong></span></div>
    <p class="pending-copy">Do not retry an ambiguous provider result until its charge status is known.</p>
  </div>`);
  setStatus(pending
    ? `Provider failure. ${reserved == null ? "Reservation amount unavailable" : `${currency(reserved)} remains reserved`} pending reconciliation; it has not been charged or released.`
    : `Provider failure. API settlement state is ${stateText}. Review the budget and usage summary before retrying.`);
}

function showUsageDetail(requestId) {
  const entry = (overview?.entries ?? []).find(item => item.request_id === requestId);
  if (!entry) return;
  const route = entry.route ?? {};
  const total = entry.total_tokens ?? Number(entry.input_tokens ?? 0) + Number(entry.output_tokens ?? 0);
  setTagAndResult("Usage entry", `<div class="result-panel success" role="status"><div class="result-head"><div><h3 class="result-title">Usage entry linked to request</h3><p class="result-copy">This billable record belongs to the current tenant.</p></div><span class="state-pill">Completed</span></div><hr class="divider"><div class="detail-grid"><div class="detail"><span>Request ID</span><strong class="mono">${escape(entry.request_id)}</strong></div><div class="detail"><span>Selected route</span><strong>${escape(route.provider ?? "provider")} / ${escape(route.model ?? "model")}</strong></div><div class="detail"><span>Settled cost</span><strong>${currency(entry.cost_uusd)}</strong></div><div class="detail"><span>Tokens</span><strong>${total}</strong></div></div></div>`);
  setStatus(`Usage entry ${entry.request_id}. ${currency(entry.cost_uusd)} settled for ${total} tokens.`);
}

async function refreshOverview() {
  const tenantId = mode === "simulated" ? selectedTenant : undefined;
  overview = await adapter.getOverview(tenantId);
  if (mode === "api") renderStorageMode(overview.storageMode);
  renderBudget();
  renderUsage();
}

async function handleSubmit(event) {
  event.preventDefault();
  if (busy) return;
  const prompt = $("#prompt").value.trim();
  if (!prompt) {
    $("#prompt").focus();
    setStatus("Enter a prompt before running the request.");
    return;
  }
  setPageAlert("");
  busy = true;
  $("#submit-button").disabled = true;
  $("#submit-button").querySelector("span").textContent = "Working...";
  renderLoading();
  const selectedScenario = mode === "simulated" || localDemoMode
    ? document.querySelector("input[name='scenario']:checked").value
    : "success";
  try {
    const result = await adapter.submitRequest({
      tenantId: selectedTenant,
      model: $("#model").value,
      prompt,
      maxTokens: Number($("#max-tokens").value.split(" ")[0]),
      scenario: selectedScenario
    });
    if (result.kind === "success") {
      if (mode === "simulated") {
        await refreshOverview();
      } else {
        try { await refreshOverview(); }
        catch {
          if (result.budget && overview) { overview.budget = result.budget; renderBudget(); }
          setPageAlert("The request succeeded, but the live usage history could not refresh. The displayed history may be stale.");
        }
      }
      renderSuccess(result);
    } else if (result.kind === "denied") {
      if (result.budget && overview) { overview.budget = result.budget; renderBudget(); }
      if (mode === "api") {
        try { await refreshOverview(); }
        catch { setPageAlert("The gateway denied the request before provider invocation, but the usage overview could not refresh."); }
      }
      renderDenial(result);
    } else if (result.kind === "failure") {
      if (mode === "simulated") {
        await refreshOverview();
      } else {
        if (result.budget && overview) { overview.budget = result.budget; renderBudget(); }
        try {
          await refreshOverview();
        } catch {
          setPageAlert("The provider outcome is uncertain and the usage overview could not refresh. Treat the reservation as pending; do not assume it was released.");
        }
      }
      renderFailure(result);
    } else {
      throw new Error("The request adapter returned an unknown result.");
    }
  } catch (error) {
    const apiMessage = "The gateway call failed without a confirmed result. The provider may have received it; recheck usage and reservation state before retrying. No fixture fallback was used.";
    const fixtureMessage = "The simulated request could not be completed. Fixture state was not switched or reset.";
    setPageAlert(`${mode === "api" ? apiMessage : fixtureMessage} ${error.message}`);
    setStatus(`${mode === "api" ? "Gateway request outcome is unconfirmed" : "Simulated request failed"}. ${error.message}`);
    $("#outcome-tag").textContent = "Connection error";
    $("#outcome").innerHTML = `<div class="result-panel failure" role="alert"><h3 class="result-title">${mode === "api" ? "Gateway outcome unconfirmed" : "Simulated request unavailable"}</h3><p class="result-copy">${escape(error.message)} ${mode === "api" ? "The provider may have received this request. Check usage and reservation state before retrying. No fixture data was loaded." : "The fixture state was left unchanged."}</p></div>`;
  } finally {
    finishLoading();
  }
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function readLocalValue(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function initialsFor(name) {
  return String(name || "A").trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "A";
}

function applyProfile(profile = defaultProfile) {
  const name = String(profile.name || defaultProfile.name).trim();
  const email = String(profile.email || defaultProfile.email).trim();
  const initials = initialsFor(name);
  $("#profile-name").value = name;
  $("#profile-email").value = email;
  $("#profile-display-name").textContent = name;
  $("#profile-display-email").textContent = email;
  $("#profile-avatar").textContent = initials;
  $("#settings-avatar").textContent = initials;
}

function renderDateGreeting() {
  const today = new Date();
  $("#date-label").textContent = today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }).toUpperCase();
}

function setAuthView(view, focus = true) {
  if (!new Set(["login", "register", "forgot-password"]).has(view)) return;
  currentAuthView = view;
  $("#app-shell").hidden = true;
  $("#auth-shell").hidden = false;
  $(".skip-link").href = "#auth-title";
  $("#auth-name-field").hidden = view !== "register";
  $("#auth-terms").hidden = view !== "register";
  $("#auth-password-field").hidden = view === "forgot-password";
  $("#forgot-link").hidden = view !== "login";
  $("#auth-name").required = view === "register";
  $("#auth-terms-checkbox").required = view === "register";
  const password = $("#auth-password");
  password.required = view !== "forgot-password";
  password.autocomplete = view === "register" ? "new-password" : "current-password";
  const copy = {
    login: ["ACCOUNT", "Sign in", "Use your workspace account to continue.", "Sign in", "Need an account?", "Create one", "register"],
    register: ["ACCOUNT", "Create account", "Set up an account for your workspace.", "Create account", "Already have an account?", "Sign in", "login"],
    "forgot-password": ["ACCOUNT RECOVERY", "Reset password", "Enter your email to continue.", "Send reset link", "Remembered your password?", "Back to sign in", "login"]
  }[view];
  $("#auth-eyebrow").textContent = copy[0];
  $("#auth-title").textContent = copy[1];
  $("#auth-copy").textContent = copy[2];
  $("#auth-submit").innerHTML = `${copy[3]} <span aria-hidden="true">↗</span>`;
  $("#auth-switch-copy").textContent = copy[4];
  $("#auth-switch-link").textContent = copy[5];
  $("#auth-switch-link").dataset.auth = copy[6];
  $("#auth-switch-link").href = `#${copy[6]}`;
  $("#auth-notice").hidden = true;
  if (focus) requestAnimationFrame(() => $("#auth-title").focus());
  document.title = `${view === "register" ? "Create account" : view === "forgot-password" ? "Reset password" : "Sign in"} — Aegis`;
}

function navigatePage(page, { focus = true, updateHash = true } = {}) {
  const target = document.querySelector(`#page-${CSS.escape(page)}`);
  if (!target) return false;
  currentPage = page;
  $("#auth-shell").hidden = true;
  $("#app-shell").hidden = false;
  $(".skip-link").href = "#main";
  document.querySelectorAll(".page-view").forEach(view => { view.hidden = view !== target; });
  document.querySelectorAll(".nav-link[data-page]").forEach(link => {
    const active = link.dataset.page === page;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const pageNames = { overview: "Overview", requests: "Request lab", usage: "Usage & budgets", "api-keys": "API keys", team: "Team", settings: "Settings" };
  $("#breadcrumb-current").textContent = pageNames[page] ?? "Overview";
  if (updateHash) history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${page}`);
  document.title = `${pageNames[page] ?? "Overview"} — Aegis Gateway`;
  if (focus) {
    const heading = target.querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      requestAnimationFrame(() => heading.focus({ preventScroll: true }));
    }
  }
  return true;
}

function showAuthNotice(message) {
  const notice = $("#auth-notice");
  notice.textContent = message;
  notice.hidden = false;
}

function attachSaasInteractions() {
  applyProfile(readLocalValue(profileStorageKey, defaultProfile));
  const prefs = readLocalValue(preferencesStorageKey, { budgetAlerts: true, productUpdates: false });
  $("#pref-budget-alerts").checked = prefs.budgetAlerts !== false;
  $("#pref-product-updates").checked = prefs.productUpdates === true;

  document.addEventListener("click", event => {
    const pageLink = event.target.closest("[data-page]");
    if (pageLink) {
      event.preventDefault();
      navigatePage(pageLink.dataset.page);
      return;
    }
    const authLink = event.target.closest("[data-auth]");
    if (authLink) {
      event.preventDefault();
      setAuthView(authLink.dataset.auth);
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${authLink.dataset.auth}`);
      return;
    }
    const modeLink = event.target.closest("[data-mode]");
    if (modeLink) {
      const next = new URL(window.location.href);
      if (modeLink.dataset.mode === "api") next.searchParams.set("mode", "api");
      else next.searchParams.delete("mode");
      window.location.assign(next.href);
    }
  });

  document.querySelectorAll("[data-settings-tab]").forEach(link => link.addEventListener("click", event => {
    event.preventDefault();
    document.querySelectorAll("[data-settings-tab]").forEach(item => item.classList.toggle("active", item === link));
    const section = document.querySelector(link.getAttribute("href"));
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    section?.focus?.({ preventScroll: true });
  }));

  $("#auth-form").addEventListener("submit", event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const message = currentAuthView === "forgot-password"
      ? "Password recovery is not connected in this preview. No reset email was sent. Use “Explore the demo workspace” to continue."
      : "Identity service is not connected in this preview. No account was created and no password was sent or stored. Use “Explore the demo workspace” to continue.";
    showAuthNotice(message);
    setStatus(message);
  });

  $("#profile-form").addEventListener("submit", event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const profile = { name: $("#profile-name").value.trim(), email: $("#profile-email").value.trim() };
    try { localStorage.setItem(profileStorageKey, JSON.stringify(profile)); } catch { /* The form still updates for this page view. */ }
    applyProfile(profile);
    $("#profile-save-note").textContent = "Profile saved in this browser preview.";
    showToast("Preview profile updated.");
    setStatus("Profile updated in this browser preview. No account service was contacted.");
  });

  const savePreferences = () => {
    const value = { budgetAlerts: $("#pref-budget-alerts").checked, productUpdates: $("#pref-product-updates").checked };
    try { localStorage.setItem(preferencesStorageKey, JSON.stringify(value)); } catch { /* Preferences remain active in this page view. */ }
    $("#preferences-save-note").textContent = "Preview preferences saved in this browser.";
    setStatus("Notification preferences saved in this browser preview.");
  };
  $("#pref-budget-alerts").addEventListener("change", savePreferences);
  $("#pref-product-updates").addEventListener("change", savePreferences);

  $(".help-button").addEventListener("click", () => showToast("Support is not connected in this preview."));
  $(".workspace-switcher").addEventListener("click", () => showToast("This preview contains one synthetic workspace."));

  const hash = window.location.hash.slice(1);
  if (["login", "register", "forgot-password"].includes(hash)) setAuthView(hash, false);
  else navigatePage(document.querySelector(`#page-${CSS.escape(hash)}`) ? hash : "overview", { focus: false, updateHash: false });
}

async function initialize() {
  renderDateGreeting();
  attachSaasInteractions();
  renderMode();
  await populateTenants();
  $("#request-form").addEventListener("submit", handleSubmit);
  $("#reset-button").addEventListener("click", async () => {
    adapter.reset?.();
    clearOutcome();
    await refreshOverview();
    showToast("Synthetic demo data reset.");
    setStatus("Synthetic demo data restored to its seed values.");
  });
  try {
    await refreshOverview();
    setStatus(mode === "simulated"
      ? "Fixture dashboard ready. No gateway or provider is connected."
      : `Gateway data loaded for ${overview.tenantName}; storage mode is ${overview.storageMode ?? "unknown"}.`);
  } catch (error) {
    setPageAlert(`${error.message} To use synthetic data, open this page without the mode=api query parameter.`);
    renderStorageMode("unknown");
    $("#tenant-control").hidden = true;
    $("#outcome-tag").textContent = "API unavailable";
    $("#outcome").innerHTML = `<div class="result-panel failure" role="alert"><h3 class="result-title">Gateway API is not configured</h3><p class="result-copy">${escape(error.message)} The UI has not called a model provider.</p></div>`;
    setStatus(`Gateway API mode unavailable. ${error.message}`);
  }
}

initialize();
