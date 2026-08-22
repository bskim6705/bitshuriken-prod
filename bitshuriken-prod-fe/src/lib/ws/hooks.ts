"use client";

import { useEffect, useState } from "react";
import { getWsClient } from "./client";

/**
 * Subscribe to a WS stream and surface the latest payload.
 * Pass `null` to pause — component unmounts/remount flip handled by effect.
 * `path` selects the gateway (default /ws/market).
 */
export function useWsStream<T>(stream: string | null, path?: string): T | null {
  const [data, setData] = useState<T | null>(null);
  // 스트림 키 변경 시 렌더 중 리셋 (effect 내 setState 회피)
  const [prevStream, setPrevStream] = useState(stream);
  if (stream !== prevStream) {
    setPrevStream(stream);
    setData(null);
  }

  useEffect(() => {
    if (!stream) return;
    const client = getWsClient(path);
    const unsub = client.subscribe(stream, (payload) => {
      setData(payload as T);
    });
    return () => {
      unsub();
    };
  }, [stream, path]);

  return data;
}
