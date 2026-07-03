"use client";

import { useEffect } from "react";
import { useCurrentUser } from "@/lib/hooks/use-auth";
import { useUserStream } from "@/lib/hooks/use-trading";
import { useFuturesUserStream, getFuturesUserWs } from "@/lib/hooks/use-futures-user";
import { getUserWsClient } from "@/lib/ws/user-client";
import { pushNotification, type NotificationLevel } from "./store";
import type { ExecutionReport } from "@/lib/types/trading";
import type { MarginCallEvent } from "@/lib/types/futures";

const TERMINAL = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

function levelForStatus(status: string): NotificationLevel {
  if (status === "FILLED") return "success";
  if (status === "REJECTED" || status === "EXPIRED") return "error";
  return "info";
}

function onExecReport(data: unknown, market: "SPOT" | "FUTURES"): void {
  const r = data as ExecutionReport;
  if (!TERMINAL.has(r.status)) return;
  const price = r.price && Number(r.price) > 0 ? `@ ${r.price}` : "market";
  pushNotification({
    level: levelForStatus(r.status),
    title: `${r.symbol} ${r.side} ${r.status.toLowerCase()}`,
    body: `${r.type} · ${r.executedQty ?? "0"} ${price} · ${market}`,
    id: `exec:${market}:${r.orderId}:${r.status}`,
  });
}

function onMarginCall(data: unknown): void {
  const e = data as MarginCallEvent;
  const who = e.marginMode === "CROSS" ? "Cross" : e.symbol;
  pushNotification({
    level: "warning",
    title: `Margin call · ${who}`,
    body: `Margin ratio ${e.marginRatio}`,
    id: `margincall:${who}:${e.marginRatio}`,
  });
}

/**
 * 로그인 중 user-data WS(spot /ws/user + futures /ws/fuser)를 구독해 주요 이벤트를 알림으로 적재.
 * TopNav에서 1회 마운트. 스트림 연결은 refcount 공유라 다른 화면과 중복 연결되지 않는다.
 */
export function useNotificationFeed(): void {
  const { data: user } = useCurrentUser();
  const userId = user?.id ?? null;

  // 알림이 앱 전역에서 동작하도록 연결 보장(이미 연결돼 있으면 공유).
  useUserStream();
  useFuturesUserStream();

  useEffect(() => {
    if (!userId) return;
    const spot = getUserWsClient();
    const fut = getFuturesUserWs();
    const offs = [
      spot.on("executionReport", (d) => onExecReport(d, "SPOT")),
      fut.on("executionReport", (d) => onExecReport(d, "FUTURES")),
      fut.on("MARGIN_CALL", onMarginCall),
    ];
    return () => offs.forEach((off) => off());
  }, [userId]);
}
