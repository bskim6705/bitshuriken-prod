import { SymbolHeader } from "@/components/trade/symbol-header";
import { ChartPanel } from "@/components/trade/chart-panel";
import { OrderBook } from "@/components/trade/order-book";
import { OrderForm } from "@/components/trade/order-form";
import { RecentTrades } from "@/components/trade/recent-trades";
import { PositionsPanel } from "@/components/trade/positions-panel";

export default async function TradePage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;
  const upper = symbol.toUpperCase();

  return (
    // 터미널 높이를 뷰포트보다 크게 잡아 패널 행을 늘린다 — 넘치는 만큼 페이지가 스크롤된다.
    <div className="flex flex-col h-[calc(130vh-3rem)] min-h-[600px]">
      <SymbolHeader symbol={upper} />
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
        <div style={{ gridArea: "ob" }} className="min-h-0 overflow-hidden"><OrderBook symbol={upper} /></div>
        <div style={{ gridArea: "chart" }} className="min-h-0 overflow-hidden"><ChartPanel symbol={upper} /></div>
        <div style={{ gridArea: "trades" }} className="min-h-0 overflow-hidden"><RecentTrades symbol={upper} /></div>
        <div style={{ gridArea: "form" }} className="min-h-0 overflow-hidden"><OrderForm symbol={upper} /></div>
        <div style={{ gridArea: "pos" }} className="min-h-0 overflow-hidden"><PositionsPanel symbol={upper} /></div>
      </div>
    </div>
  );
}
