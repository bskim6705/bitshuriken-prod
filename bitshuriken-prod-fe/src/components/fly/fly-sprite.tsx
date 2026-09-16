"use client";

import { useEffect, useState } from "react";

/** 파리 id → 색상 hue (같은 파리는 늘 같은 색; 부모와 다른 색은 돌연변이의 표식이다). */
export function flyHue(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}
export const flyColor = (id: string, l = 55): string => `hsl(${flyHue(id)} 70% ${l}%)`;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/**
 * 파리 스프라이트 — 몸통(줄무늬)·머리·붉은 복안·다리·날개 두 장. running이면 날개가 떤다(SMIL, 감속 모션 설정 존중).
 * relegation은 붉게, stopped는 흐리게. viewBox 64×48, 크기는 size(px).
 */
export function FlySprite({
  id,
  size = 40,
  flying = true,
  dimmed = false,
  danger = false,
  crown = false,
  title,
}: {
  id: string;
  size?: number;
  flying?: boolean;
  dimmed?: boolean;
  danger?: boolean;
  crown?: boolean;
  title?: string;
}) {
  const reduced = useReducedMotion();
  const body = danger ? "hsl(350 70% 50%)" : flyColor(id, 48);
  const bodyDark = danger ? "hsl(350 70% 32%)" : flyColor(id, 30);
  const wing = danger ? "rgba(246,70,93,0.35)" : `hsl(${flyHue(id)} 70% 80% / 0.35)`;
  const animate = flying && !reduced;
  return (
    <svg
      viewBox="0 0 64 48"
      width={size}
      height={(size * 48) / 64}
      role="img"
      aria-label={title ?? id}
      className={dimmed ? "opacity-40" : ""}
      style={{ overflow: "visible" }}
    >
      {title && <title>{title}</title>}
      {/* 다리 */}
      <g stroke={bodyDark} strokeWidth="1.2" strokeLinecap="round" fill="none">
        <path d="M26 34 l-5 6 l-2 3" />
        <path d="M32 35 l0 7 l-1 3" />
        <path d="M38 34 l5 6 l2 3" />
      </g>
      {/* 날개 */}
      <g opacity="0.95">
        <g transform="rotate(-24 33 21)">
          <ellipse cx="45" cy="21" rx="14" ry="5.5" fill={wing} stroke={bodyDark} strokeWidth="0.6" />
          {animate && (
            <animateTransform attributeName="transform" type="rotate" values="-24 33 21;-40 33 21;-24 33 21" dur="0.16s" repeatCount="indefinite" />
          )}
        </g>
        <g transform="rotate(24 31 21)">
          <ellipse cx="19" cy="21" rx="14" ry="5.5" fill={wing} stroke={bodyDark} strokeWidth="0.6" />
          {animate && (
            <animateTransform attributeName="transform" type="rotate" values="24 31 21;40 31 21;24 31 21" dur="0.16s" repeatCount="indefinite" />
          )}
        </g>
      </g>
      {/* 배·가슴 */}
      <ellipse cx="32" cy="30" rx="9" ry="12" fill={body} />
      <g fill={bodyDark} opacity="0.7">
        <rect x="24" y="30" width="16" height="2" rx="1" />
        <rect x="24.5" y="35" width="15" height="2" rx="1" />
        <rect x="26" y="40" width="12" height="1.6" rx="0.8" />
      </g>
      <ellipse cx="32" cy="20" rx="7.5" ry="6" fill={bodyDark} />
      {/* 머리·복안·더듬이 */}
      <circle cx="32" cy="11" r="6" fill={body} />
      <ellipse cx="28.5" cy="10.5" rx="3" ry="3.6" fill="#d9302c" />
      <ellipse cx="35.5" cy="10.5" rx="3" ry="3.6" fill="#d9302c" />
      <circle cx="29.3" cy="9.6" r="0.9" fill="#ffd0c8" opacity="0.8" />
      <circle cx="36.3" cy="9.6" r="0.9" fill="#ffd0c8" opacity="0.8" />
      <path d="M30 5.5 l-2 -3 M34 5.5 l2 -3" stroke={bodyDark} strokeWidth="1" strokeLinecap="round" />
      {crown && (
        <path d="M24 3 l3 -5 l3 3 l2 -5 l2 5 l3 -3 l3 5 z" fill="#fcd535" stroke="#b8901c" strokeWidth="0.6" transform="translate(0 -4)" />
      )}
    </svg>
  );
}
