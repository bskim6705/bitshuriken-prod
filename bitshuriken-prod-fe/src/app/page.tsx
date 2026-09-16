"use client";

import { APP_VERSION } from "@/lib/version";
import Link from "next/link";
import { TopNav } from "@/components/layout/top-nav";
import { Footer } from "@/components/layout/footer";
import { TopMarketsCard } from "@/components/landing/top-markets-card";
import { MoversBlock } from "@/components/landing/movers-block";
import { TickerStrip } from "@/components/landing/ticker-strip";
import { MarketStats } from "@/components/landing/market-stats";
import { MarketsPreview } from "@/components/landing/markets-preview";
import { useT } from "@/lib/i18n/provider";

const AUDIENCE = [
  { titleKey: "landing.audience.teamTitle", bodyKey: "landing.audience.teamBody" },
  { titleKey: "landing.audience.agentsTitle", bodyKey: "landing.audience.agentsBody" },
  { titleKey: "landing.audience.publicTitle", bodyKey: "landing.audience.publicBody" },
] as const;

const LIQUIDITY = [
  { k: "landing.liquidity.quoteAssetKey", v: "landing.liquidity.quoteAssetValue" },
  { k: "landing.liquidity.sourceKey", v: "landing.liquidity.sourceValue" },
  { k: "landing.liquidity.rebalancingKey", v: "landing.liquidity.rebalancingValue" },
  { k: "landing.liquidity.depositsKey", v: "landing.liquidity.depositsValue" },
  { k: "landing.liquidity.offPlatformKey", v: "landing.liquidity.offPlatformValue" },
] as const;

const FAQ = [
  { qKey: "landing.faq.q1", aKey: "landing.faq.a1" },
  { qKey: "landing.faq.q2", aKey: "landing.faq.a2" },
  { qKey: "landing.faq.q3", aKey: "landing.faq.a3" },
  { qKey: "landing.faq.q4", aKey: "landing.faq.a4" },
  { qKey: "landing.faq.q5", aKey: "landing.faq.a5" },
  { qKey: "landing.faq.q6", aKey: "landing.faq.a6" },
  { qKey: "landing.faq.q7", aKey: "landing.faq.a7" },
  { qKey: "landing.faq.q8", aKey: "landing.faq.a8" },
] as const;

const RULES = [
  "landing.terms.rule1",
  "landing.terms.rule2",
  "landing.terms.rule3",
  "landing.terms.rule4",
  "landing.terms.rule5",
  "landing.terms.rule6",
  "landing.terms.rule7",
] as const;

const API_DOCS_HREF = "/api-docs";

export default function HomePage() {
  const t = useT();
  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-7 border-b border-line bg-surface text-[11px] flex items-center overflow-hidden shrink-0">
        <div className="px-3 flex items-center gap-5 whitespace-nowrap text-text-dim">
          <span className="text-accent font-medium shrink-0">{t("landing.bar.testEnv")}</span>
          <span>{t("landing.bar.simulated")}</span>
          <span className="text-text-muted">·</span>
          <span>{t("landing.bar.synthetic")}</span>
          <span className="text-text-muted">·</span>
          <span>{t("landing.bar.openReg")}</span>
          <span className="text-text-muted">·</span>
          <span>{t("landing.bar.liquidityLabel")} <span className="text-text">{t("landing.bar.liquidityValue")}</span></span>
          <span className="text-text-muted">·</span>
          <span>{t("landing.bar.statusLabel")} <span className="text-up">{t("landing.bar.statusValue")}</span></span>
        </div>
      </div>

      <TopNav />
      <TickerStrip />

      <main className="flex-1">
        {/* HERO */}
        <section className="border-b border-line">
          <div className="px-3 py-10 md:py-14 max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-8 items-start">
            <div>
              <div className="inline-flex items-center gap-2 text-[11px] mb-4">
                <span className="text-accent border border-accent/40 bg-accent/10 px-2 py-0.5 font-medium tracking-wider">
                  {t("landing.hero.badge")}
                </span>
                <span className="text-text-dim tnum">{APP_VERSION}</span>
              </div>
              <h1 className="text-[32px] md:text-[42px] font-semibold tracking-tight leading-[1.1]">
                {t("landing.hero.titleLine1")}
                <br />
                <span className="text-accent">{t("landing.hero.titleAccent")}</span>
                {t("landing.hero.titleSuffix")}
              </h1>
              <p className="mt-4 text-[14px] text-text-dim max-w-[60ch] leading-relaxed">
                {t("landing.hero.body")}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <Link
                  href="/trade/BTCUSDT"
                  className="h-10 px-5 inline-flex items-center text-[13px] font-medium bg-accent text-bg hover:bg-accent-hover"
                >
                  {t("landing.hero.openTerminal")}
                </Link>
                <Link
                  href={API_DOCS_HREF}
                  className="h-10 px-5 inline-flex items-center gap-1.5 text-[13px] border border-line-strong text-text hover:bg-raised"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
                  </svg>
                  {t("landing.hero.apiDocs")}
                </Link>
                <Link
                  href="/markets"
                  className="h-10 px-5 inline-flex items-center text-[13px] text-text-dim hover:text-text"
                >
                  {t("landing.hero.viewMarkets")}
                </Link>
              </div>
              <p className="mt-5 text-[11px] text-text-muted leading-relaxed max-w-[52ch]">
                {t("landing.hero.note")}
              </p>
            </div>

            <TopMarketsCard />
          </div>
        </section>

        {/* LIVE MARKET STATS */}
        <section className="border-b border-line bg-surface">
          <div className="px-3 py-5 max-w-[1400px] mx-auto">
            <MarketStats />
          </div>
        </section>

        {/* MARKETS TABLE (live) */}
        <section className="border-b border-line">
          <div className="px-3 py-6 max-w-[1400px] mx-auto">
            <MarketsPreview />
          </div>
        </section>

        {/* GAINERS & LOSERS */}
        <section className="border-b border-line bg-surface">
          <div className="px-3 py-6 max-w-[1400px] mx-auto grid grid-cols-1 md:grid-cols-2 gap-3">
            <MoversBlock />
          </div>
        </section>

        {/* API ACCESS CALLOUT */}
        <section className="border-b border-line">
          <div className="px-3 py-6 max-w-[1400px] mx-auto grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-center">
            <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-5 items-start">
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] font-medium tracking-wider text-accent border border-accent/40 bg-accent/10 px-2 py-0.5">
                  {t("landing.api.developers")}
                </span>
                <span className="text-[10px] text-text-muted tnum tracking-wider">OPENAPI 3.1</span>
              </div>
              <div>
                <h2 className="text-[15px] font-semibold">{t("landing.api.title")}</h2>
                <p className="text-[12px] text-text-dim mt-1 leading-relaxed max-w-[72ch]">
                  {t("landing.api.body")}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-text-muted">
                  <span>{t("landing.api.baseUrl")} · <span className="text-text-dim tnum">api.bitshuriken.local</span></span>
                  <span>{t("landing.api.auth")} · <span className="text-text-dim">HMAC-SHA256</span></span>
                  <span>{t("landing.api.streams")} · <span className="text-text-dim">WebSocket</span></span>
                  <span>{t("landing.api.spec")} · <span className="text-text-dim">OPENAPI 3.1</span></span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 justify-start md:justify-end">
              <Link
                href={API_DOCS_HREF}
                className="h-10 px-5 inline-flex items-center gap-1.5 text-[13px] font-medium bg-accent text-bg hover:bg-accent-hover"
              >
                {t("landing.api.openSwagger")}
              </Link>
            </div>
          </div>
        </section>

        {/* WHO IT'S FOR */}
        <section className="border-b border-line bg-surface">
          <div className="px-3 py-8 max-w-[1400px] mx-auto">
            <div className="flex items-end justify-between mb-3">
              <h2 className="text-[13px] font-medium">{t("landing.audience.heading")}</h2>
              <span className="text-[11px] text-text-muted">{t("landing.audience.caption")}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {AUDIENCE.map((a, i) => (
                <div key={a.titleKey} className="bg-bg border border-line p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[14px] font-semibold">{t(a.titleKey)}</h3>
                    <span className="text-[10px] text-text-muted tnum">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <p className="text-[12px] text-text-dim leading-relaxed">{t(a.bodyKey)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* LIQUIDITY MODEL */}
        <section className="border-b border-line">
          <div className="px-3 py-8 max-w-[1400px] mx-auto grid grid-cols-1 md:grid-cols-[1fr_1.2fr] gap-8 items-start">
            <div>
              <h2 className="text-[13px] font-medium mb-2">{t("landing.liquidity.heading")}</h2>
              <p className="text-[13px] text-text-dim leading-relaxed">
                {t("landing.liquidity.body1")}
              </p>
              <p className="text-[12px] text-text-muted leading-relaxed mt-3">
                {t("landing.liquidity.body2")}
              </p>
            </div>
            <div className="bg-surface border border-line">
              {LIQUIDITY.map((row, i) => (
                <div
                  key={row.k}
                  className={`flex items-center justify-between px-3 py-2.5 ${
                    i < LIQUIDITY.length - 1 ? "border-b border-line" : ""
                  }`}
                >
                  <span className="text-[12px] text-text-dim">{t(row.k)}</span>
                  <span className="text-[12px] text-text tnum">{t(row.v)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="border-b border-line bg-surface">
          <div className="px-3 py-8 max-w-[1400px] mx-auto">
            <div className="flex items-end justify-between mb-3">
              <h2 className="text-[13px] font-medium">{t("landing.faq.heading")}</h2>
              <span className="text-[11px] text-text-muted">
                {t("landing.faq.caption")}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {FAQ.map((f) => (
                <div key={f.qKey} className="bg-bg border border-line px-4 py-3">
                  <p className="text-[13px] font-medium text-text">{t(f.qKey)}</p>
                  <p className="text-[12px] text-text-dim mt-1 leading-relaxed">{t(f.aKey)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* TERMS OF USE */}
        <section id="terms" className="border-b border-line scroll-mt-12">
          <div className="px-3 py-6 max-w-[1400px] mx-auto">
            <div className="flex items-end justify-between mb-2">
              <h2 className="text-[13px] font-medium">{t("landing.terms.heading")}</h2>
              <span className="text-[11px] text-text-muted">
                {t("landing.terms.caption")}
              </span>
            </div>
            <div className="border border-accent/30 bg-accent/5">
              <ul className="divide-y divide-accent/10">
                {RULES.map((ruleKey, i) => (
                  <li
                    key={ruleKey}
                    className="flex items-start gap-3 px-4 py-2.5 text-[12px] text-text-dim"
                  >
                    <span className="text-accent tnum shrink-0 pt-[1px]">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="leading-relaxed">{t(ruleKey)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
