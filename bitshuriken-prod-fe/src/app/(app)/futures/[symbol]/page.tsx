import { FuturesSymbolHeader } from "@/components/futures/symbol-header";
import { FuturesChartPanel } from "@/components/futures/chart-panel";
import { FuturesOrderBook } from "@/components/futures/order-book";
import { FuturesOrderForm } from "@/components/futures/order-form";
import { FuturesRecentTrades } from "@/components/futures/recent-trades";
import { FuturesPositionsPanel } from "@/components/futures/positions-panel";

export default async function FuturesPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;
  const upper = symbol.toUpperCase();

  return (
    // 터미널 높이를 뷰포트보다 크게 잡아 패널 행을 늘린다 — 넘치는 만큼 페이지가 스크롤된다.
    <div className="flex flex-col h-[calc(130vh-3rem)] min-h-[600px]">
      <FuturesSymbolHeader symbol={upper} />
      <div
        className="grid gap-px bg-line flex-1 min-h-0"
        style={{
          gridTemplateColumns: "240px 1fr 220px 280px",
          gridTemplateRows: "minmax(0, 1fr) 240px",
          gridTemplateAreas: `
            "ob chart  trades form"
            "pos pos   pos    pos"
          `,
        }}
      >
        <div style={{ gridArea: "ob" }} className="min-h-0 overflow-hidden"><FuturesOrderBook symbol={upper} /></div>
        <div style={{ gridArea: "chart" }} className="min-h-0 overflow-hidden"><FuturesChartPanel symbol={upper} /></div>
        <div style={{ gridArea: "trades" }} className="min-h-0 overflow-hidden"><FuturesRecentTrades symbol={upper} /></div>
        <div style={{ gridArea: "form" }} className="min-h-0 overflow-hidden"><FuturesOrderForm symbol={upper} /></div>
        <div style={{ gridArea: "pos" }} className="min-h-0 overflow-hidden"><FuturesPositionsPanel symbol={upper} /></div>
      </div>
    </div>
  );
}
