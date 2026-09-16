import type { FlyDetail, FlyLeagueSummary } from "@/lib/types/fly";

// 초파리 리그(bitshuriken-prod-fly)는 별개 서비스 — 자기 포트(:5130)의 읽기 전용 JSON API를 CORS로 열어 둔다.
// 미설정이면 로컬 기본값; 없어도 다른 화면은 영향 없다 (이 화면만 offline 표시).
export const FLY_API_URL = process.env.NEXT_PUBLIC_FLY_API_URL ?? "http://localhost:5130";

interface Envelope<T> {
  ok: boolean;
  data: T;
  error?: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${FLY_API_URL}${path}`, { cache: "no-store" });
  const json = (await res.json()) as Envelope<T>;
  if (!res.ok || !json.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json.data;
}

export const fetchFlyLeague = (): Promise<FlyLeagueSummary> => get<FlyLeagueSummary>("/api/league");
export const fetchFlyDetail = (slot: number): Promise<FlyDetail | null> => get<FlyDetail | null>(`/api/fly/${slot}`);
