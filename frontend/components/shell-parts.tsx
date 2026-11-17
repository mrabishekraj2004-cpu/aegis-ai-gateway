"use client";

import { ChevronDown, Info, Plug } from "lucide-react";
import { useConsole } from "./session";
export { Badge } from "./ui";

export function DateRange() {
  const { days, setDays } = useConsole();
  return <label className="range-control"><span className="sr-only">Reporting date range</span>
    <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
      <option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option>
    </select><ChevronDown size={15} aria-hidden="true" />
  </label>;
}
export function ConsoleButton({ compact = false }: { compact?: boolean }) {
  const { connection, openConnection } = useConsole();
  return <button className={compact ? "footer-link" : `button ${connection ? "secondary" : "primary"}`} onClick={openConnection}>
    <Plug size={16} aria-hidden="true" />{connection ? "Manage connection" : "Connect gateway"}
  </button>;
}
export function SourceNotice() {
  const { connection } = useConsole();
  if (connection) return null;
  return <div className="data-source">
    <Info size={16} aria-hidden="true" />
    <p>You’re viewing sample data.</p>
  </div>;
}
