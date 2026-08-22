"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "./use-auth";
import { getUserWsClient } from "@/lib/ws/user-client";
import { debouncedInvalidate } from "@/lib/api/invalidate";
import { createFuturesListenKey } from "@/lib/api/futures";
import type { FuturesUserStreamName, MarginCallEvent } from "@/lib/types/futures";

const FUSER_PATH = "/ws/fuser";

/** /ws/fuser 싱글톤 — spot /ws/user와 동일하게 bs_session 쿠키 인증. */
export function getFuturesUserWs() {
  return getUserWsClient<FuturesUserStreamName>(FUSER_PATH);
}

// 마지막 구독 해제 시에만 disconnect (싱글톤 공유 refcount)
let fuserStreamRefs = 0;

/**
 * 로그인 상태에서만 fuser-ws 연결 유지.
 * 모든 (재)연결 시 ['futures'] prefix 캐시 invalidate — REST 재동기화.
 */
export function useFuturesUserStream(): void {
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    const client = getFuturesUserWs();
    client.setListenKeyProvider(createFuturesListenKey);
    const offOpen = client.onOpen(() => {
      debouncedInvalidate(qc, ["futures"]);
    });
    fuserStreamRefs += 1;
    client.connect();
    return () => {
      offOpen();
      fuserStreamRefs -= 1;
      if (fuserStreamRefs === 0) client.disconnect();
    };
  }, [userId, qc]);
}

// CROSS는 계정 단위 ratio 1건 — symbol이 비어올 수 있어 고정 키로 묶는다.
function noticeKey(e: MarginCallEvent): string {
  return e.marginMode === "CROSS" ? "CROSS" : e.symbol;
}

/**
 * MARGIN_CALL 스트림 구독 — 청산 사전 경고를 dismissable 배너로 노출.
 * BE가 warn 밴드 진입 시 1회만 발송(디바운스)하므로 FE는 받은 이벤트를 그대로 표시.
 */
export function useMarginCallNotice(): {
  notices: MarginCallEvent[];
  dismiss: (key: string) => void;
} {
  useFuturesUserStream();
  const [byKey, setByKey] = useState<Map<string, MarginCallEvent>>(new Map());

  useEffect(() => {
    return getFuturesUserWs().on("MARGIN_CALL", (data) => {
      const event = data as MarginCallEvent;
      setByKey((prev) => {
        const next = new Map(prev);
        next.set(noticeKey(event), event);
        return next;
      });
    });
  }, []);

  const dismiss = useCallback((key: string) => {
    setByKey((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  return { notices: [...byKey.values()], dismiss };
}
