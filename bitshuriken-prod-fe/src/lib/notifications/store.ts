"use client";

import { useSyncExternalStore } from "react";

// 인앱 알림 스토어 — 세션 메모리(새로고침 시 비움). user-data WS는 replay가 없어 알림은 세션 범위.
// 외부 스토어 + useSyncExternalStore 패턴(zustand 미사용 프로젝트 컨벤션에 맞춤).

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface AppNotification {
  id: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  ts: number;
  read: boolean;
}

const MAX = 50;
const EMPTY: AppNotification[] = [];

let items: AppNotification[] = EMPTY;
const changeListeners = new Set<() => void>();
const toastListeners = new Set<(n: AppNotification) => void>();

function emitChange(): void {
  for (const l of changeListeners) l();
}

function subscribe(l: () => void): () => void {
  changeListeners.add(l);
  return () => changeListeners.delete(l);
}
function getSnapshot(): AppNotification[] {
  return items;
}
function getServerSnapshot(): AppNotification[] {
  return EMPTY;
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `n-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export interface PushInput {
  level: NotificationLevel;
  title: string;
  body?: string;
  /** 결정적 id를 주면 동일 이벤트 중복 push를 막는다(예: 체결 리포트 재발송). */
  id?: string;
}

export function pushNotification(input: PushInput): void {
  const id = input.id ?? newId();
  if (items.some((i) => i.id === id)) return; // dedupe
  const item: AppNotification = {
    id,
    level: input.level,
    title: input.title,
    body: input.body,
    ts: Date.now(),
    read: false,
  };
  items = [item, ...items].slice(0, MAX);
  emitChange();
  for (const l of toastListeners) l(item);
}

export function markAllRead(): void {
  if (!items.some((i) => !i.read)) return;
  items = items.map((i) => (i.read ? i : { ...i, read: true }));
  emitChange();
}

export function clearAll(): void {
  if (items.length === 0) return;
  items = EMPTY;
  emitChange();
}

/** 새 알림 1건마다 호출되는 transient 콜백(토스트용). 반환값은 해제 함수. */
export function onToast(cb: (n: AppNotification) => void): () => void {
  toastListeners.add(cb);
  return () => toastListeners.delete(cb);
}

export function useNotifications(): { items: AppNotification[]; unread: number } {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const unread = list.reduce((n, i) => (i.read ? n : n + 1), 0);
  return { items: list, unread };
}
