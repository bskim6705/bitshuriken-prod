"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, RateLimitedError } from "@/lib/api/client";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.status === 401) return false;
              return failureCount < 2;
            },
            // 429면 server Retry-After를 존중, 그 외에는 지수 백오프.
            retryDelay: (attempt, error) =>
              error instanceof RateLimitedError
                ? error.retryAfter * 1000
                : Math.min(1000 * 2 ** attempt, 30_000),
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
