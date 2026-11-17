"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowUpRight, ChevronDown, ChevronRight, CircleDot, FlaskConical, Menu, Moon, Plug, Search, Sun, Unplug,
} from "lucide-react";
import { navigation } from "@/lib/navigation";
import { errorText, gatewayBase, models, type Session } from "@/lib/gateway";
import { Badge, ConsoleButton } from "./shell-parts";
import { Empty, IconButton, Modal, Notice, Spinner } from "./ui";
import { ConsoleProvider, useConsole } from "./session";

function Branding() {
  return <Link href="/" className="brand" aria-label="Aegis overview">
    <span className="brand-mark" aria-hidden="true">A.</span>
    <span><strong>Aegis</strong><small>AI Gateway</small></span>
  </Link>;
}

function SideNav({ current, onNavigate, label }: { current: string; onNavigate?: () => void; label: string }) {
  return <nav className="side-nav" aria-label={label}>{["Monitor", "Configure", "Develop"].map((group) =>
    <div className="nav-group" key={group}><p>{group}</p>{navigation.filter((item) => item.group === group).map((item) =>
      <Link key={item.key} href={item.href} onClick={onNavigate} aria-current={current === item.key ? "page" : undefined}
        className={`nav-link ${current === item.key ? "active" : ""}`}>
        <item.icon aria-hidden="true" size={17} strokeWidth={1.8} /><span>{item.label}</span>
      </Link>)}</div>)}</nav>;
}

function SidebarFoot() {
  const { connection, openConnection } = useConsole();
  return <div className="sidebar-foot"><button className="workspace-button" type="button" onClick={openConnection}>
    <span className="workspace-icon">{connection ? <CircleDot size={17} /> : <FlaskConical size={17} />}</span>
    <span><strong>{connection ? "Connected workspace" : "Demo workspace"}</strong><small>{connection ? new URL(connection.base).host : "Sample telemetry"}</small></span>
    <ChevronDown size={13} aria-hidden="true" />
  </button></div>;
}

function ConnectionDialog() {
  const { connection, setConnection, connectionOpen, closeConnection } = useConsole();
  return <Modal title={connection ? "Gateway connection" : "Connect to a gateway"}
    description="Use the origin of your FastAPI gateway and a scoped credential."
    open={connectionOpen} onClose={closeConnection}>
    <ConnectForm key={connection?.base ?? "new"} existing={connection} finish={(value) => { setConnection(value); closeConnection(); }} />
  </Modal>;
}

function ConnectForm({ existing, finish }: { existing: Session | null; finish: (value: Session | null) => void }) {
  const [kind, setKind] = useState<Session["kind"]>(existing?.kind ?? "key");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setError("");
    const operation = new AbortController();
    pending.current = operation;
    try {
      const base = gatewayBase(String(fields.get("base") ?? ""));
      const token = String(fields.get("token") ?? "").trim();
      const tenant = kind === "user" ? String(fields.get("tenant") ?? "").trim() : "";
      if (!token || /\s/.test(token)) throw new Error("Enter only the bearer credential, without the Bearer prefix.");
      if (kind === "user" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(tenant)) {
        throw new Error("Enter the tenant’s lowercase UUID.");
      }
      setBusy(true);
      const session: Session = { base, token, tenant, kind };
      const catalog = await models(session, AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)]));
      if (!Array.isArray(catalog)) throw new Error("This URL did not return an Aegis model catalog.");
      if (!operation.signal.aborted) finish(session);
    } catch (cause) {
      if (!operation.signal.aborted) setError(errorText(cause));
    } finally {
      if (!operation.signal.aborted) setBusy(false);
    }
  }
  return <form className="form-stack" onSubmit={connect}>
    <label>Gateway URL<input name="base" required type="url" autoComplete="off" defaultValue={existing?.base ?? process.env.NEXT_PUBLIC_AEGIS_URL ?? "http://127.0.0.1:8000"} /></label>
    <label>Credential type<select value={kind} onChange={(event) => setKind(event.target.value as Session["kind"])}>
      <option value="key">Scoped API key</option><option value="user">OIDC access token</option>
    </select></label>
    <label>{kind === "key" ? "API key" : "OIDC access token"}<input key={kind} name="token" required type="password"
      autoComplete="off" spellCheck={false} /></label>
    {kind === "user" && <label>Tenant UUID<input name="tenant" defaultValue={existing?.tenant} required autoComplete="off" spellCheck={false} /></label>}
    <p className="small muted">The connection check needs <code>models:read</code>. Credentials stay in this tab’s memory and are cleared on reload.</p>
    {error && <Notice tone="bad">{error}</Notice>}
    <div className="modal-actions">
      {existing && <button type="button" className="button secondary" onClick={() => finish(null)}><Unplug size={15} /> Use demo data</button>}
      <button type="submit" className="button primary" disabled={busy}>{busy ? <Spinner /> : <Plug size={15} />}{busy ? "Connecting…" : "Connect gateway"}</button>
    </div>
  </form>;
}

function ThemeButton() {
  function toggle() {
    const data = document.documentElement.dataset;
    const theme = data.theme === "dark" ? "light" : "dark";
    data.theme = theme;
    try { localStorage.setItem("aegis-theme", theme); } catch { /* The theme still applies in memory. */ }
  }
  return <IconButton label="Switch light or dark theme" onClick={toggle}>
    <Moon className="show-light" size={18} /><Sun className="show-dark" size={18} />
  </IconButton>;
}

function ShellBody({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = navigation.find((item) => item.href.replace(/\/$/, "") === pathname.replace(/\/$/, "")) ?? navigation[0];
  const { connection } = useConsole();
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const [term, setTerm] = useState("");
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (document.querySelector("dialog[open]")) return;
        event.preventDefault();
        setTerm("");
        setSearch(true);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const matches = navigation.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(term.toLowerCase().trim()));
  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="sidebar"><Branding /><SideNav current={current.key} label="Main navigation" /><SidebarFoot /></aside>
    <div className="app-main">
      <header className="topbar">
        <div className="breadcrumbs">
          <IconButton className="mobile-menu" label="Open navigation" onClick={() => setMenu(true)}><Menu size={20} /></IconButton>
          <Link href="/" className="mobile-brand" aria-label="Aegis overview"><span className="brand-mark" aria-hidden="true">A.</span><span>Aegis</span></Link>
          <span className="crumb-root">Console</span><ChevronRight className="crumb-root" size={14} aria-hidden="true" /><span className="crumb-current">{current.label}</span>
        </div>
        <div className="top-actions">
          <button className="search-opener" onClick={() => { setTerm(""); setSearch(true); }} aria-label="Find a page">
            <Search size={16} /><span>Find a page</span><kbd>Ctrl K</kbd>
          </button>
          <span className="top-divider" />
          <ThemeButton />
          <span className="header-source"><Badge tone={connection ? "good" : "neutral"} dot>{connection ? "Live gateway" : "Demo data"}</Badge></span>
        </div>
      </header>
      <main id="main" tabIndex={-1}>{children}</main>
      <footer className="page-footer"><span>Aegis AI Gateway</span><ConsoleButton compact /></footer>
    </div>
    <Modal title="Navigation" open={menu} onClose={() => setMenu(false)} className="mobile-dialog">
      <SideNav current={current.key} label="Mobile navigation" onNavigate={() => setMenu(false)} /><SidebarFoot />
    </Modal>
    <Modal title="Find a page" open={search} onClose={() => setSearch(false)} className="search-dialog">
      <label className="form-stack">Search console<input value={term} autoFocus onChange={(event) => setTerm(event.target.value)} placeholder="Try routing or costs" /></label>
      <div className="search-results">
        {matches.map((item) => <Link href={item.href} onClick={() => setSearch(false)} key={item.key}>
          <item.icon size={17} /><span><strong>{item.label}</strong><small>{item.description}</small></span><ArrowUpRight size={15} />
        </Link>)}
        {!matches.length && <Empty title="No matching pages" description="Try a different search." />}
      </div>
    </Modal>
    <ConnectionDialog />
  </div>;
}

export function AppShell({ children }: { children: ReactNode }) {
  return <ConsoleProvider><ShellBody>{children}</ShellBody></ConsoleProvider>;
}
