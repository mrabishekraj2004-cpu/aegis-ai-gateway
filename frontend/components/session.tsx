"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { errorText, type Session } from "@/lib/gateway";

const ConsoleContext = createContext<{
  connection: Session | null;
  setConnection: (value: Session | null) => void;
  sessionVersion: number;
  days: number;
  setDays: (value: number) => void;
  openConnection: () => void;
  connectionOpen: boolean;
  closeConnection: () => void;
} | null>(null);

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [connection, setCurrent] = useState<Session | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);
  const setConnection = useCallback((value: Session | null) => {
    setCurrent(value);
    setSessionVersion((version) => version + 1);
  }, []);
  const [days, setDays] = useState(14);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const openConnection = useCallback(() => setConnectionOpen(true), []);
  const closeConnection = useCallback(() => setConnectionOpen(false), []);
  const value = useMemo(() => ({ connection, setConnection, sessionVersion, days, setDays, openConnection, closeConnection, connectionOpen }),
    [connection, setConnection, sessionVersion, days, openConnection, closeConnection, connectionOpen]);
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole() {
  const ctx = useContext(ConsoleContext);
  if (!ctx) throw new Error("Console state is unavailable.");
  return ctx;
}

export function useResource<T>(load: ((signal: AbortSignal) => Promise<T>) | null) {
  const [result, setResult] = useState<{ load: typeof load; refresh: number; data?: T; error?: string; cause?: unknown } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const retry = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    if (!load) return;
    const handle = new AbortController();
    const signal = AbortSignal.any([handle.signal, AbortSignal.timeout(20_000)]);
    void load(signal).then(
      (data) => { if (!handle.signal.aborted) setResult({ load, refresh, data }); },
      (error) => {
        if (!handle.signal.aborted) setResult({ load, refresh,
          error: signal.aborted ? "The gateway took too long to respond." : errorText(error), cause: error });
      },
    );
    return () => handle.abort();
  }, [load, refresh]);
  const current = result?.load === load && result.refresh === refresh ? result : null;
  return { data: current?.data, error: current?.error, cause: current?.cause, loading: Boolean(load && !current), retry };
}
