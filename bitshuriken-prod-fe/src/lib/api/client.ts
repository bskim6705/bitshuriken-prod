import { acquire, release, pauseFor, weightOf } from "./limiter";
import { coalesce, stableStringify } from "./dedupe";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL;
if (!BASE_URL) {
  throw new Error("NEXT_PUBLIC_API_URL is required");
}

// futures는 별도 BE 앱(프로세스) — /futures/*가 여기에 산다
const FUTURES_BASE_URL = process.env.NEXT_PUBLIC_FUTURES_API_URL;
if (!FUTURES_BASE_URL) {
  throw new Error("NEXT_PUBLIC_FUTURES_API_URL is required");
}

// portal: cross-product 앱 — /auth/*, /auth/api-keys, /account/transfers
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_API_URL;
if (!PORTAL_BASE_URL) {
  throw new Error("NEXT_PUBLIC_PORTAL_API_URL is required");
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: number | null;

  constructor(message: string, status: number, code: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** 429/418 — rate limit. retryAfter(초)·server used-weight를 실어 호출측이 백오프하게 한다. */
export class RateLimitedError extends ApiError {
  readonly retryAfter: number;
  readonly usedWeight: number | null;

  constructor(
    message: string,
    status: number,
    code: number | null,
    retryAfter: number,
    usedWeight: number | null,
  ) {
    super(message, status, code);
    this.name = "RateLimitedError";
    this.retryAfter = retryAfter;
    this.usedWeight = usedWeight;
  }
}

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

// interface 타입(인덱스 시그니처 없음)도 그대로 받도록 object 사용
type Body = object | undefined;

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

async function doRequest<T>(baseUrl: string, method: string, path: string, body?: Body): Promise<T> {
  await acquire(baseUrl, weightOf(method, path));

  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  // 뮤테이션 멱등키 — 현재 BE는 무시(forward-compat). 동시 더블클릭 방어는 버튼 isPending 담당.
  if (method !== "GET") headers["Idempotency-Key"] = newIdempotencyKey();

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      credentials: "include",
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    release(baseUrl, null);
    throw err;
  }
  release(baseUrl, res.headers);

  let payload: Envelope<T> | null = null;
  try {
    payload = (await res.json()) as Envelope<T>;
  } catch (err) {
    console.error("[api] failed to parse JSON response", { method, path, status: res.status, err });
  }

  if (!res.ok) {
    const message = payload?.message ?? `${res.status} ${res.statusText}`;
    if (res.status === 429 || res.status === 418) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 1;
      pauseFor(baseUrl, retryAfter);
      const used = Number(res.headers.get("X-MBX-USED-WEIGHT-1M"));
      throw new RateLimitedError(
        message,
        res.status,
        payload?.code ?? null,
        retryAfter,
        Number.isFinite(used) ? used : null,
      );
    }
    throw new ApiError(message, res.status, payload?.code ?? null);
  }

  if (!payload) {
    throw new ApiError("Empty or non-JSON response body", res.status);
  }

  return payload.data;
}

// GET은 동시 동일 요청을 코얼레싱(dedupe). 뮤테이션은 합치지 않는다(정상 반복 요청 보존).
async function request<T>(baseUrl: string, method: string, path: string, body?: Body): Promise<T> {
  if (method === "GET") {
    return coalesce(`${baseUrl}|GET|${path}|${stableStringify(body)}`, () =>
      doRequest<T>(baseUrl, method, path, body),
    );
  }
  return doRequest<T>(baseUrl, method, path, body);
}

export const api = {
  get: <T>(path: string) => request<T>(BASE_URL, "GET", path),
  post: <T>(path: string, body?: Body) => request<T>(BASE_URL, "POST", path, body),
  put: <T>(path: string, body?: Body) => request<T>(BASE_URL, "PUT", path, body),
  patch: <T>(path: string, body?: Body) => request<T>(BASE_URL, "PATCH", path, body),
  del: <T>(path: string) => request<T>(BASE_URL, "DELETE", path),
};

export const futuresApi = {
  get: <T>(path: string) => request<T>(FUTURES_BASE_URL, "GET", path),
  post: <T>(path: string, body?: Body) => request<T>(FUTURES_BASE_URL, "POST", path, body),
  put: <T>(path: string, body?: Body) => request<T>(FUTURES_BASE_URL, "PUT", path, body),
  patch: <T>(path: string, body?: Body) => request<T>(FUTURES_BASE_URL, "PATCH", path, body),
  del: <T>(path: string) => request<T>(FUTURES_BASE_URL, "DELETE", path),
};

export const portalApi = {
  get: <T>(path: string) => request<T>(PORTAL_BASE_URL, "GET", path),
  post: <T>(path: string, body?: Body) => request<T>(PORTAL_BASE_URL, "POST", path, body),
  put: <T>(path: string, body?: Body) => request<T>(PORTAL_BASE_URL, "PUT", path, body),
  patch: <T>(path: string, body?: Body) => request<T>(PORTAL_BASE_URL, "PATCH", path, body),
  del: <T>(path: string) => request<T>(PORTAL_BASE_URL, "DELETE", path),
};

