// 동시 진행 중인 동일 GET 요청을 하나의 promise로 합친다(코얼레싱).
// react-query는 queryKey로 GET을 dedupe하지만 raw fetch/비-query 호출은 못 잡으므로 그 빈틈을 메운다.

const inFlight = new Map<string, Promise<unknown>>();

export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** 키 순서를 정규화해 동일 내용 body가 같은 문자열로 해시되게 한다. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
