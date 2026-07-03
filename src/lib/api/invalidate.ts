import type { QueryClient, QueryKey } from "@tanstack/react-query";

// WS 이벤트/재연결로 쏟아지는 invalidateQueries 버스트를 키별 trailing 디바운스로 1회로 합친다.
// (재연결 폭주 시 같은 prefix를 N번 무효화 → 1번 refetch.)

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function debouncedInvalidate(qc: QueryClient, queryKey: QueryKey, ms = 200): void {
  const key = JSON.stringify(queryKey);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void qc.invalidateQueries({ queryKey });
    }, ms),
  );
}
