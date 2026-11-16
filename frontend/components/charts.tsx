"use client";

import { useId } from "react";
import {
  Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { compact, type SeriesPoint } from "@/lib/data";
import { Table } from "./ui";

type ChartType = "requests" | "cost" | "tokens" | "errors" | "latency";
type Point = Partial<SeriesPoint> & { label: string; count?: number };
const labels: Record<string, string> = {
  requests: "Requests", previous: "Prior period", reported: "Reported", estimated: "Estimated",
  adjusted: "Adjusted", input: "Input", output: "Output", error: "Error rate", count: "Requests",
};
const money = (value: number) => `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function Chart({ title, data, type, demo = false, height = 250 }: {
  title: string; data: Point[]; type: ChartType; demo?: boolean; height?: number;
}) {
  const id = useId().replace(/[^\w-]/g, "");
  const keys = type === "requests" ? (demo ? ["requests", "previous"] : ["requests"]) :
    type === "cost" ? ["reported", "estimated", "adjusted"] : type === "tokens" ? ["input", "output"] :
      type === "errors" ? ["error"] : ["count"];
  function valueLabel(value: number) {
    return type === "cost" ? money(value) : type === "errors" ? `${value}%` : value.toLocaleString("en-US");
  }
  return <figure className="chart" aria-labelledby={`${id}-title`}>
    <figcaption id={`${id}-title`} className="sr-only">{title}. A data table follows the chart.</figcaption>
    <div className="plot" style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 600, height }}>
        <ComposedChart data={data} margin={{ top: 10, right: 15, bottom: 2, left: 2 }} accessibilityLayer={false}>
          <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-main)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--chart-main)" stopOpacity={0.025} />
          </linearGradient></defs>
          <CartesianGrid stroke="var(--grid)" strokeDasharray="4 4" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={19} tickMargin={10}
            tick={{ fontSize: 11, fill: "var(--muted)" }} />
          <YAxis axisLine={false} tickLine={false} width={46} tickMargin={7} tickCount={5}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            tickFormatter={(value) => type === "cost" ? `$${compact(value)}` : type === "errors" ? `${value}%` : compact(value)} />
          <Tooltip
            cursor={{ stroke: "var(--chart-cursor)", fill: "var(--chart-hover)" }}
            contentStyle={{ border: "1px solid var(--line)", background: "var(--surface)", borderRadius: 8, color: "var(--ink)" }}
            labelStyle={{ color: "var(--ink)", fontWeight: 650 }}
            itemStyle={{ color: "var(--ink)" }}
            formatter={(value, name) => [valueLabel(Number(value)), labels[String(name)] ?? String(name)]} />
          {type === "requests" && <>
            {demo && <Line type="monotone" dataKey="previous" stroke="var(--chart-secondary)" strokeWidth={1.75} strokeDasharray="5 5" dot={false} isAnimationActive={false} />}
            <Area type="monotone" dataKey="requests" stroke="var(--chart-main)" fill={`url(#${id})`} strokeWidth={2.3}
              activeDot={{ r: 4, fill: "var(--chart-main)", stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} />
          </>}
          {type === "cost" && <>
            <Bar stackId="spend" dataKey="reported" fill="var(--chart-main)" maxBarSize={29} isAnimationActive={false} />
            <Bar stackId="spend" dataKey="estimated" fill="var(--chart-gold)" maxBarSize={29} isAnimationActive={false} />
            <Bar stackId="spend" dataKey="adjusted" fill="var(--chart-secondary)" maxBarSize={29} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </>}
          {type === "tokens" && <>
            <Bar stackId="tokens" dataKey="input" fill="var(--chart-main)" maxBarSize={27} isAnimationActive={false} />
            <Bar stackId="tokens" dataKey="output" fill="var(--chart-secondary)" maxBarSize={27} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </>}
          {type === "errors" && <Line type="monotone" dataKey="error" stroke="var(--chart-gold)" strokeWidth={2.2} dot={false} isAnimationActive={false} />}
          {type === "latency" && <Bar dataKey="count" fill="var(--chart-main)" maxBarSize={42} radius={[3, 3, 0, 0]} isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    <div className="chart-caption">
      <div className="legend">{keys.map((key, index) => <span key={key}><i data-color={key === "previous" ? "prior" :
        key === "error" || key === "estimated" ? "gold" : index ? "secondary" : "main"} />{labels[key]}</span>)}</div>
      <details><summary>View data</summary>
        <Table label={title} headers={[type === "latency" ? "Duration" : "Date (UTC)", ...keys.map((key) => labels[key])]}>
          {data.map((point) => <tr key={point.day ?? point.label}><td>{point.label}</td>{keys.map((key) =>
            <td key={key} className="mono">{valueLabel(Number(point[key as keyof Point] ?? 0))}</td>)}</tr>)}
        </Table>
      </details>
    </div>
  </figure>;
}
