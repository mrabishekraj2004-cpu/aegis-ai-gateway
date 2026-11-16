"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertCircle, ArrowRight, CircleHelp, Inbox, LoaderCircle, X, type LucideIcon } from "lucide-react";
import Link from "next/link";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";
export function Badge({ children, tone = "neutral", dot = false }: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  return <span className={`badge badge-${tone}`}>{dot && <span className="status-dot" aria-hidden="true" />}{children}</span>;
}
export function IconButton({ label, children, onClick, className = "" }: {
  label: string; children: ReactNode; onClick: () => void; className?: string;
}) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}
export function Hint({ text }: { text: string }) {
  return <span className="hint-wrap"><button className="hint" type="button" aria-label={text}><CircleHelp size={15} /></button>
    <span className="hint-pop" aria-hidden="true">{text}</span></span>;
}
export function Panel({ title, description, action, children, className = "" }: {
  title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`panel ${className}`}>
    <div className="panel-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>
    {children}
  </section>;
}
export function PageHead({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <header className="page-head"><div><h1>{title}</h1><p>{description}</p></div>{children && <div className="page-actions">{children}</div>}</header>;
}
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link className="text-link" href={href}>{children}<ArrowRight size={14} aria-hidden="true" /></Link>;
}
export function Notice({ children, tone = "info", icon: Icon = AlertCircle }: {
  children: ReactNode; tone?: Tone; icon?: LucideIcon;
}) {
  return <div className={`notice notice-${tone}`} role={tone === "bad" ? "alert" : undefined}><Icon size={17} aria-hidden="true" /><div>{children}</div></div>;
}
export function Busy({ label = "Loading gateway data", compact = false }: { label?: string; compact?: boolean }) {
  return <div className={`busy ${compact ? "busy-compact" : ""}`} role="status">
    <span className="sr-only">{label}</span><span className="skeleton" /><span className="skeleton" /><span className="skeleton" />
  </div>;
}
export function Empty({ title, description, icon: Icon = Inbox, children }: {
  title: string; description: string; icon?: LucideIcon; children?: ReactNode;
}) {
  return <div className="empty"><span className="empty-icon"><Icon size={20} aria-hidden="true" /></span>
    <div><p className="empty-title">{title}</p><p>{description}</p></div>{children}</div>;
}
export function Issue({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="issue"><Notice tone="bad">{message}</Notice>{retry && <button className="button secondary" onClick={retry}>Try again</button>}</div>;
}
export function Metric({ label, value, detail, icon: Icon, children }: {
  label: string; value: string; detail?: string; icon: LucideIcon; children?: ReactNode;
}) {
  return <div className="metric"><div className="metric-label"><Icon size={16} aria-hidden="true" />{label}</div>
    <div className="metric-value">{value}</div><div className="metric-detail">{children}{detail && <span>{detail}</span>}</div>
  </div>;
}
export function Table({ label, headers, children, className = "" }: {
  label: string; headers: ReactNode[]; children: ReactNode; className?: string;
}) {
  return <div className={`table-scroll ${className}`} tabIndex={0} role="region" aria-label={`${label} table`}>
    <table><caption className="sr-only">{label}</caption><thead><tr>
      {headers.map((heading, index) => <th scope="col" key={index}>{heading}</th>)}
    </tr></thead><tbody>{children}</tbody></table></div>;
}
export function Modal({ title, description, open, onClose, children, className = "" }: {
  title: string; description?: string; open: boolean; onClose: () => void; children: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const node = ref.current;
    if (open && !node?.open) node?.showModal();
    if (!open && node?.open) node.close();
  }, [open]);
  return <dialog ref={ref} aria-labelledby={id} className={`modal ${className}`} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    {open && <div className="modal-content">
      <div className="modal-head"><h2 id={id}>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={18} /></IconButton></div>
      {description && <p className="modal-description">{description}</p>}
      {children}
    </div>}
  </dialog>;
}

export function Spinner() {
  return <LoaderCircle className="spinner" size={16} aria-hidden="true" />;
}
