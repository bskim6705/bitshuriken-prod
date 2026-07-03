import { defineMessages } from "./define";

// 여러 상품(현물/선물/옵션/DEX)이 공유하는 components/common/* 위젯 문자열. "widgets.*" 네임스페이스.
export const widgets = defineMessages({
  en: {
    // chart panel
    "widgets.chart.title": "Chart",
    "widgets.chart.loadingIntervals": "Loading intervals…",
    "widgets.chart.intervalsError": "Failed to load intervals",
    "widgets.chart.loadingChart": "Loading chart…",

    // order book / depth columns
    "widgets.orderBook.priceWithUnit": "Price ({unit})",
    "widgets.orderBook.qtyWithUnit": "Qty ({unit})",
    "widgets.orderBook.qty": "Qty",

    // recent trades
    "widgets.recentTrades.title": "Market Trades",
    "widgets.recentTrades.empty": "No trades yet",

    // pair selector
    "widgets.pairSelector.noResults": "No results",

    // order form shared pieces
    "widgets.orderForm.placed": "Order placed",
    "widgets.orderForm.tif": "TIF",
    "widgets.orderForm.logIn": "Log In",
    "widgets.orderForm.signUp": "Sign Up",

    // trade-history columns
    "widgets.trade.role": "Role",
    "widgets.trade.maker": "Maker",
    "widgets.trade.taker": "Taker",
  },
  ko: {
    "widgets.chart.title": "차트",
    "widgets.chart.loadingIntervals": "간격 불러오는 중…",
    "widgets.chart.intervalsError": "간격을 불러오지 못했습니다",
    "widgets.chart.loadingChart": "차트 불러오는 중…",

    "widgets.orderBook.priceWithUnit": "가격 ({unit})",
    "widgets.orderBook.qtyWithUnit": "수량 ({unit})",
    "widgets.orderBook.qty": "수량",

    "widgets.recentTrades.title": "마켓 체결",
    "widgets.recentTrades.empty": "체결 내역 없음",

    "widgets.pairSelector.noResults": "결과 없음",

    "widgets.orderForm.placed": "주문 접수됨",
    "widgets.orderForm.tif": "TIF",
    "widgets.orderForm.logIn": "로그인",
    "widgets.orderForm.signUp": "회원가입",

    "widgets.trade.role": "역할",
    "widgets.trade.maker": "메이커",
    "widgets.trade.taker": "테이커",
  },
  ja: {
    "widgets.chart.title": "チャート",
    "widgets.chart.loadingIntervals": "間隔を読み込み中…",
    "widgets.chart.intervalsError": "間隔の読み込みに失敗しました",
    "widgets.chart.loadingChart": "チャートを読み込み中…",

    "widgets.orderBook.priceWithUnit": "価格 ({unit})",
    "widgets.orderBook.qtyWithUnit": "数量 ({unit})",
    "widgets.orderBook.qty": "数量",

    "widgets.recentTrades.title": "マーケット約定",
    "widgets.recentTrades.empty": "約定履歴がありません",

    "widgets.pairSelector.noResults": "結果がありません",

    "widgets.orderForm.placed": "注文を受け付けました",
    "widgets.orderForm.tif": "TIF",
    "widgets.orderForm.logIn": "ログイン",
    "widgets.orderForm.signUp": "新規登録",

    "widgets.trade.role": "ロール",
    "widgets.trade.maker": "メイカー",
    "widgets.trade.taker": "テイカー",
  },
  zh: {
    "widgets.chart.title": "图表",
    "widgets.chart.loadingIntervals": "正在加载周期…",
    "widgets.chart.intervalsError": "加载周期失败",
    "widgets.chart.loadingChart": "正在加载图表…",

    "widgets.orderBook.priceWithUnit": "价格 ({unit})",
    "widgets.orderBook.qtyWithUnit": "数量 ({unit})",
    "widgets.orderBook.qty": "数量",

    "widgets.recentTrades.title": "市场成交",
    "widgets.recentTrades.empty": "暂无成交",

    "widgets.pairSelector.noResults": "无结果",

    "widgets.orderForm.placed": "下单成功",
    "widgets.orderForm.tif": "TIF",
    "widgets.orderForm.logIn": "登录",
    "widgets.orderForm.signUp": "注册",

    "widgets.trade.role": "角色",
    "widgets.trade.maker": "挂单",
    "widgets.trade.taker": "吃单",
  },
});
