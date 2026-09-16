import type { Locale } from "../config";
import { common } from "./common";
import { widgets } from "./widgets";
import { chrome } from "./chrome";
import { auth } from "./auth";
import { landing } from "./landing";
import { markets } from "./markets";
import { leaderboard } from "./leaderboard";
import { trade } from "./trade";
import { futures } from "./futures";
import { wallet } from "./wallet";
import { portfolio } from "./portfolio";
import { account } from "./account";
import { orders } from "./orders";
import { admin } from "./admin";
import { fly } from "./fly";

// 영역 모듈을 로케일별 단일 사전으로 병합. en 스프레드로 전체 키 유니온을 도출한다.
const en = {
  ...common.en,
  ...widgets.en,
  ...chrome.en,
  ...auth.en,
  ...landing.en,
  ...markets.en,
  ...leaderboard.en,
  ...trade.en,
  ...futures.en,
  ...wallet.en,
  ...portfolio.en,
  ...account.en,
  ...orders.en,
  ...admin.en,
  ...fly.en,
};

export type TranslationKey = keyof typeof en;

export const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  en,
  ko: {
    ...common.ko,
    ...widgets.ko,
    ...chrome.ko,
    ...auth.ko,
    ...landing.ko,
    ...markets.ko,
    ...leaderboard.ko,
    ...trade.ko,
    ...futures.ko,
    ...wallet.ko,
    ...portfolio.ko,
    ...account.ko,
    ...orders.ko,
    ...admin.ko,
  ...fly.ko,
  },
  ja: {
    ...common.ja,
    ...widgets.ja,
    ...chrome.ja,
    ...auth.ja,
    ...landing.ja,
    ...markets.ja,
    ...leaderboard.ja,
    ...trade.ja,
    ...futures.ja,
    ...wallet.ja,
    ...portfolio.ja,
    ...account.ja,
    ...orders.ja,
    ...admin.ja,
  ...fly.ja,
  },
  zh: {
    ...common.zh,
    ...widgets.zh,
    ...chrome.zh,
    ...auth.zh,
    ...landing.zh,
    ...markets.zh,
    ...leaderboard.zh,
    ...trade.zh,
    ...futures.zh,
    ...wallet.zh,
    ...portfolio.zh,
    ...account.zh,
    ...orders.zh,
    ...admin.zh,
  ...fly.zh,
  },
};
