import { notFound } from "next/navigation";
import { navigation } from "@/lib/navigation";
import { Analytics, Cost, Reliability } from "@/components/monitor";
import { Routing } from "@/components/routing-console";
import { Access, Providers } from "@/components/inventory";
import { Playground } from "@/components/playground";

const pages = { analytics: Analytics, cost: Cost, reliability: Reliability, routing: Routing, providers: Providers, access: Access, playground: Playground } as const;

export function generateStaticParams() {
  return Object.keys(pages).map((view) => ({ view }));
}

export async function generateMetadata({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  return { title: navigation.find((item) => item.key === view)?.label ?? "Page unavailable" };
}

export default async function ViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  if (!Object.hasOwn(pages, view)) notFound();
  const Screen = pages[view as keyof typeof pages];
  return <Screen />;
}
