"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWsStream } from "@/lib/ws/hooks";
import { getWsClient } from "@/lib/ws/client";
import { fetchFuturesExchangeInfo, fetchFuturesKlines } from "@/lib/api/futures";
import type { DepthSnapshot, Kline, Ticker24h, WsTrade } from "@/lib/types/market";
import type { FuturesExchangeInfo, FuturesSymbolInfo, MarkPrice } from "@/lib/types/futures";

// /ws/fmarket 스트림 페이로드는 spot /ws/market과 동일 형태 (+ markPrice)
const FMARKET_PATH = "/ws/fmarket";

export function useFuturesTickers(): Ticker24h[] | null {
  return useWsStream<Ticker24h[]>("!ticker@arr", FMARKET_PATH);
}

export function useFuturesTicker(symbol: string | null): Ticker24h | null {
  const stream = useMemo(
    () => (symbol ? `${symbol.toLowerCase()}@ticker` : null),
    [symbol],
  );
  return useWsStream<Ticker24h>(stream, FMARKET_PATH);
}

export function useFuturesDepth(symbol: string | null): DepthSnapshot | null {
  const stream = useMemo(
    () => (symbol ? `${symbol.toLowerCase()}@depth` : null),
    [symbol],
  );
  return useWsStream<DepthSnapshot>(stream, FMARKET_PATH);
}

/** mark/index/lastFundingRate/nextFundingTime — index 형성 후 1s마다 push. */
export function useFuturesMarkPrice(symbol: string | null): MarkPrice | null {
  const stream = useMemo(
    () => (symbol ? `${symbol.toLowerCase()}@markPrice` : null),
    [symbol],
  );
  return useWsStream<MarkPrice>(stream, FMARKET_PATH);
}

export function useFuturesExchangeInfo() {
  return useQuery<FuturesExchangeInfo>({
    queryKey: ["futures", "exchangeInfo"],
    queryFn: fetchFuturesExchangeInfo,
    staleTime: 60 * 60 * 1000,
  });
}

export function useFuturesSymbolInfo(symbol: string | null): FuturesSymbolInfo | null {
  const { data } = useFuturesExchangeInfo();
  return useMemo(() => {
    if (!symbol || !data) return null;
    return data.symbols.find((s) => s.symbol === symbol) ?? null;
  }, [symbol, data]);
}

/** openTime 기준 update-or-append. 과거 버킷은 일치 항목만 교체. */
function mergeKline(list: Kline[], k: Kline): Kline[] {
  const last = list[list.length - 1];
  if (last && k.openTime === last.openTime) return [...list.slice(0, -1), k];
  if (!last || k.openTime > last.openTime) return [...list, k];
  const idx = list.findIndex((c) => c.openTime === k.openTime);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = k;
  return next;
}

const KLINE_INITIAL_LIMIT = 500;

/**
 * REST 초기 로드 + @kline_ 스트림 머지. 재연결 시 REST 재조회.
 * 로딩 중에는 null.
 */
export function useFuturesKlines(
  symbol: string | null,
  interval: string | null,
): Kline[] | null {
  const [klines, setKlines] = useState<Kline[] | null>(null);

  useEffect(() => {
    if (!symbol || !interval) {
      setKlines(null);
      return;
    }
    setKlines(null);

    let cancelled = false;
    let loaded = false;
    let restSeq = 0;
    let pending: Kline[] = []; // REST 도착 전 수신한 라이브 캔들 버퍼
    let retried = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      const seq = ++restSeq;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        const initial = await fetchFuturesKlines(symbol, interval, KLINE_INITIAL_LIMIT);
        if (cancelled || seq !== restSeq) return;
        loaded = true;
        retried = false;
        const buffered = pending;
        pending = [];
        setKlines(buffered.reduce(mergeKline, initial));
      } catch (err) {
        console.error("[futures klines] initial load failed", { symbol, interval, err });
        if (cancelled || seq !== restSeq || retried) return;
        // 실패 시 1회만 5초 뒤 재시도 (키 변경/언마운트 시 취소)
        retried = true;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void load();
        }, 5000);
      }
    };

    void load();

    const client = getWsClient(FMARKET_PATH);
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const unsubStream = client.subscribe(stream, (payload) => {
      const k = payload as Kline;
      if (!loaded) {
        pending = mergeKline(pending, k);
        return;
      }
      setKlines((prev) => (prev ? mergeKline(prev, k) : prev));
    });

    const unsubReconnect = client.onReconnect(() => {
      void load();
    });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubStream();
      unsubReconnect();
    };
  }, [symbol, interval]);

  return klines;
}

/**
 * Trades stream: snapshot on subscribe is most-recent N; each event is 1-element array.
 * Hook accumulates into a bounded buffer (newest first).
 */
export function useFuturesTrades(symbol: string | null, limit = 50): WsTrade[] | null {
  const [buf, setBuf] = useState<WsTrade[] | null>(null);
  // 심볼 변경 시 렌더 중 리셋 (effect 내 setState 회피)
  const [prevSymbol, setPrevSymbol] = useState(symbol);
  if (symbol !== prevSymbol) {
    setPrevSymbol(symbol);
    setBuf(null);
  }

  useEffect(() => {
    if (!symbol) return;
    const stream = `${symbol.toLowerCase()}@trade`;
    const unsub = getWsClient(FMARKET_PATH).subscribe(stream, (payload) => {
      const incoming = payload as WsTrade[];
      setBuf((prev) => {
        if (!prev) return incoming.slice(0, limit);
        // 재연결 스냅샷 재수신 등 중복 id는 drop
        const seen = new Set(prev.map((t) => t.id));
        const fresh = incoming.filter((t) => !seen.has(t.id));
        if (fresh.length === 0) return prev;
        return [...fresh, ...prev].slice(0, limit);
      });
    });
    return () => unsub();
  }, [symbol, limit]);

  return buf;
}
