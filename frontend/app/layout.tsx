import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: { default: "Overview · Aegis AI Gateway", template: "%s · Aegis AI Gateway" },
  applicationName: "Aegis AI Gateway",
  description: "Monitor and operate the Aegis multi-tenant inference gateway.",
  robots: { index: false, follow: false },
};
const theme = "try{var t=localStorage.getItem('aegis-theme');document.documentElement.dataset.theme=t==='dark'||t==='light'?t:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch{}";
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-type="software" data-theme="light" suppressHydrationWarning>
    <head><meta name="site-kind" content="software" /><meta name="page-type" content="software" /></head>
    <body><script dangerouslySetInnerHTML={{ __html: theme }} /><AppShell>{children}</AppShell></body>
  </html>;
}
