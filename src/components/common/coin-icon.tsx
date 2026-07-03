"use client";

import { useState } from "react";

/** 코인 로고. public/icons/{base}.png self-host, 없으면 placeholder 원으로 폴백. */
export function CoinIcon({
  asset,
  size = 16,
  className = "",
}: {
  asset: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const dim = { width: size, height: size };

  if (!asset || failed) {
    return (
      <span
        aria-hidden
        style={dim}
        className={`inline-block rounded-full bg-raised border border-line shrink-0 ${className}`}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/icons/${asset.toLowerCase()}.png`}
      alt={asset}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      style={dim}
      className={`rounded-full shrink-0 ${className}`}
    />
  );
}
