import { defineMessages } from "./define";

export const orders = defineMessages({
  en: {
    "orders.title": "Orders",

    "orders.tab.open": "Open Orders",
    "orders.tab.history": "Order History",
    "orders.tab.trades": "Trade History",

    "orders.filter.allPairs": "All pairs",
    "orders.filter.allSides": "All sides",

    "orders.col.pair": "Pair",
    "orders.col.trigger": "Trigger",
    "orders.col.qty": "Qty",
    "orders.col.filled": "Filled",
    "orders.col.role": "Role",

    "orders.role.maker": "Maker",
    "orders.role.taker": "Taker",

    "orders.market": "Market",
    "orders.triggered": "triggered",
    "orders.triggerGte": "Last ≥ {price}",
    "orders.triggerLte": "Last ≤ {price}",

    "orders.cancelAll": "Cancel All",
    "orders.canceling": "Canceling…",
    "orders.cancelAllHint": "Select a pair to cancel all",
    "orders.cancelFailed": "Cancel failed",
    "orders.cancelAllFailed": "Cancel all failed",

    "orders.loadMore": "Load more",
    "orders.loadMoreFailed": "Failed to load more",

    "orders.logIn": "Log In",
    "orders.empty.openSignedOut": "to view your open orders",
    "orders.empty.historySignedOut": "to view your order history",
    "orders.empty.tradesSignedOut": "to view your trade history",
    "orders.empty.open": "No open orders",
    "orders.empty.history": "No order history",
    "orders.empty.trades": "No trades yet",
  },
  ko: {
    "orders.title": "주문",

    "orders.tab.open": "미체결 주문",
    "orders.tab.history": "주문 내역",
    "orders.tab.trades": "거래 내역",

    "orders.filter.allPairs": "전체 페어",
    "orders.filter.allSides": "전체 방향",

    "orders.col.pair": "페어",
    "orders.col.trigger": "트리거",
    "orders.col.qty": "수량",
    "orders.col.filled": "체결",
    "orders.col.role": "역할",

    "orders.role.maker": "메이커",
    "orders.role.taker": "테이커",

    "orders.market": "시장가",
    "orders.triggered": "발동됨",
    "orders.triggerGte": "최종가 ≥ {price}",
    "orders.triggerLte": "최종가 ≤ {price}",

    "orders.cancelAll": "전체 취소",
    "orders.canceling": "취소 중…",
    "orders.cancelAllHint": "전체 취소하려면 페어를 선택하세요",
    "orders.cancelFailed": "취소 실패",
    "orders.cancelAllFailed": "전체 취소 실패",

    "orders.loadMore": "더 보기",
    "orders.loadMoreFailed": "추가 로드에 실패했습니다",

    "orders.logIn": "로그인",
    "orders.empty.openSignedOut": "하여 미체결 주문을 확인하세요",
    "orders.empty.historySignedOut": "하여 주문 내역을 확인하세요",
    "orders.empty.tradesSignedOut": "하여 거래 내역을 확인하세요",
    "orders.empty.open": "미체결 주문이 없습니다",
    "orders.empty.history": "주문 내역이 없습니다",
    "orders.empty.trades": "체결 내역이 없습니다",
  },
  ja: {
    "orders.title": "注文",

    "orders.tab.open": "未約定注文",
    "orders.tab.history": "注文履歴",
    "orders.tab.trades": "取引履歴",

    "orders.filter.allPairs": "すべてのペア",
    "orders.filter.allSides": "すべての方向",

    "orders.col.pair": "ペア",
    "orders.col.trigger": "トリガー",
    "orders.col.qty": "数量",
    "orders.col.filled": "約定済",
    "orders.col.role": "役割",

    "orders.role.maker": "メイカー",
    "orders.role.taker": "テイカー",

    "orders.market": "成行",
    "orders.triggered": "発動済",
    "orders.triggerGte": "最終価格 ≥ {price}",
    "orders.triggerLte": "最終価格 ≤ {price}",

    "orders.cancelAll": "すべてキャンセル",
    "orders.canceling": "キャンセル中…",
    "orders.cancelAllHint": "すべてキャンセルするにはペアを選択してください",
    "orders.cancelFailed": "キャンセルに失敗しました",
    "orders.cancelAllFailed": "一括キャンセルに失敗しました",

    "orders.loadMore": "もっと見る",
    "orders.loadMoreFailed": "追加の読み込みに失敗しました",

    "orders.logIn": "ログイン",
    "orders.empty.openSignedOut": "して未約定注文を表示",
    "orders.empty.historySignedOut": "して注文履歴を表示",
    "orders.empty.tradesSignedOut": "して取引履歴を表示",
    "orders.empty.open": "未約定注文はありません",
    "orders.empty.history": "注文履歴はありません",
    "orders.empty.trades": "取引履歴はありません",
  },
  zh: {
    "orders.title": "订单",

    "orders.tab.open": "当前委托",
    "orders.tab.history": "历史委托",
    "orders.tab.trades": "成交记录",

    "orders.filter.allPairs": "所有交易对",
    "orders.filter.allSides": "所有方向",

    "orders.col.pair": "交易对",
    "orders.col.trigger": "触发",
    "orders.col.qty": "数量",
    "orders.col.filled": "已成交",
    "orders.col.role": "角色",

    "orders.role.maker": "挂单",
    "orders.role.taker": "吃单",

    "orders.market": "市价",
    "orders.triggered": "已触发",
    "orders.triggerGte": "最新价 ≥ {price}",
    "orders.triggerLte": "最新价 ≤ {price}",

    "orders.cancelAll": "全部撤销",
    "orders.canceling": "撤销中…",
    "orders.cancelAllHint": "请选择交易对以全部撤销",
    "orders.cancelFailed": "撤销失败",
    "orders.cancelAllFailed": "全部撤销失败",

    "orders.loadMore": "加载更多",
    "orders.loadMoreFailed": "加载更多失败",

    "orders.logIn": "登录",
    "orders.empty.openSignedOut": "以查看当前委托",
    "orders.empty.historySignedOut": "以查看历史委托",
    "orders.empty.tradesSignedOut": "以查看成交记录",
    "orders.empty.open": "暂无当前委托",
    "orders.empty.history": "暂无历史委托",
    "orders.empty.trades": "暂无成交记录",
  },
});
