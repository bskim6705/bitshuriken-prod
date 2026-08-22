import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { QueryProvider } from "@/lib/providers/query-provider";
import { I18nProvider } from "@/lib/i18n/provider";
import { SiteGate } from "@/components/site-gate";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Bitshuriken",
  description:
    "A simulated spot & futures exchange for testing trading strategies and bots on a real matching engine.",
  openGraph: {
    title: "Bitshuriken",
    description:
      "A simulated spot & futures exchange for testing trading strategies and bots on a real matching engine.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0e11",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-bg text-text">
        <I18nProvider>
          <SiteGate>
            <QueryProvider>{children}</QueryProvider>
          </SiteGate>
        </I18nProvider>
      </body>
    </html>
  );
}
