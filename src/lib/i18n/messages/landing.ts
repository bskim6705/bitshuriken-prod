import { defineMessages } from "./define";

export const landing = defineMessages({
  en: {
    // top status bar
    "landing.bar.testEnv": "TEST ENVIRONMENT",
    "landing.bar.simulated": "Simulated spot & futures",
    "landing.bar.synthetic": "Synthetic balances — no deposits or withdrawals",
    "landing.bar.openReg": "Open registration · accounts subject to suspension",
    "landing.bar.liquidityLabel": "Liquidity:",
    "landing.bar.liquidityValue": "ETH testnet mining",
    "landing.bar.statusLabel": "Status:",
    "landing.bar.statusValue": "engine live",

    // hero
    "landing.hero.badge": "SIMULATED EXCHANGE · TEST ENVIRONMENT",
    "landing.hero.titleLine1": "A simulated exchange for",
    "landing.hero.titleAccent": "strategy & bot testing",
    "landing.hero.titleSuffix": ".",
    "landing.hero.body":
      "Spot and futures markets on a real matching engine, funded with synthetic balances. Build, deploy, and test trading strategies and bots — humans and automated agents, same API, same venue. Registration is open; the platform is operated by the Bitninja team.",
    "landing.hero.openTerminal": "Open Trading Terminal",
    "landing.hero.apiDocs": "API Documentation",
    "landing.hero.viewMarkets": "View Markets →",
    "landing.hero.note":
      "A closed-loop test environment. The quote asset is synthetic USDT funded via ETH-testnet mining — no deposits or withdrawals, and balances carry no off-platform value.",

    // API access callout
    "landing.api.developers": "DEVELOPERS",
    "landing.api.title": "Build on the API",
    "landing.api.body":
      "REST and WebSocket endpoints for market data, order management, and account actions. HMAC-SHA256 request signing, with per-key permissions and rate limits. Published as Swagger; the schema is the source of truth.",
    "landing.api.baseUrl": "Base URL",
    "landing.api.auth": "Auth",
    "landing.api.streams": "Streams",
    "landing.api.spec": "Spec",
    "landing.api.openSwagger": "Open Swagger →",

    // who it's for
    "landing.audience.heading": "Who it's for",
    "landing.audience.caption": "team · agents · public",
    "landing.audience.teamTitle": "Team & VIP",
    "landing.audience.teamBody":
      "The Bitninja operating team and invited VIP accounts. Internal market-making, strategy design, and manual market review.",
    "landing.audience.agentsTitle": "Automated agents & bots",
    "landing.audience.agentsBody":
      "Connect with HMAC-signed API keys and run continuously. Grid bots, market makers, and custom strategies are welcome — permissions and rate limits are scoped per key.",
    "landing.audience.publicTitle": "Public accounts",
    "landing.audience.publicBody":
      "Registration is open to anyone, with full access to every feature — spot, futures, options, and swap. Balances are synthetic and carry no off-platform value, and accounts may be suspended under our terms.",

    // liquidity model
    "landing.liquidity.heading": "Liquidity model",
    "landing.liquidity.body1":
      "We mine on Ethereum testnets and sell the resulting test-ETH into our internal market, which funds account USDT balances. This keeps the venue self-contained and removes any off-platform incentive to abuse it.",
    "landing.liquidity.body2":
      "Deposits and withdrawals are not supported. The ratio between minted liquidity and circulating synthetic USDT is rebalanced periodically by the operator.",
    "landing.liquidity.quoteAssetKey": "Quote asset",
    "landing.liquidity.quoteAssetValue": "USDT (synthetic)",
    "landing.liquidity.sourceKey": "Source",
    "landing.liquidity.sourceValue": "ETH testnet mining → internal market",
    "landing.liquidity.rebalancingKey": "Rebalancing",
    "landing.liquidity.rebalancingValue": "Periodic",
    "landing.liquidity.depositsKey": "Deposits / withdrawals",
    "landing.liquidity.depositsValue": "Not supported",
    "landing.liquidity.offPlatformKey": "Off-platform value",
    "landing.liquidity.offPlatformValue": "None",

    // FAQ
    "landing.faq.heading": "FAQ",
    "landing.faq.caption": "common questions about this environment",
    "landing.faq.q1": "What is Bitshuriken?",
    "landing.faq.a1":
      "A simulated spot and futures exchange for testing trading strategies and bots against a real matching engine. Balances are synthetic and have no off-platform value.",
    "landing.faq.q2": "Who can sign up?",
    "landing.faq.a2":
      "Anyone. Registration is open, and public accounts have full access to every feature. The Bitninja team and VIP accounts hold elevated operational access for market-making and seeding — not a higher feature tier.",
    "landing.faq.q3": "Is it free to use?",
    "landing.faq.a3":
      "Yes. There is no cost — the environment is funded internally and all balances are synthetic.",
    "landing.faq.q4": "Will my strategy translate to a real exchange?",
    "landing.faq.a4":
      "The engine follows standard price-time priority and time-in-force semantics, so execution behaves like a production venue. Signal quality remains your responsibility.",
    "landing.faq.q5": "Is there an SLA?",
    "landing.faq.a5":
      "No uptime SLA is published. This is a test environment and may be reset, restarted, or taken offline without notice.",
    "landing.faq.q6": "How do I get an API key?",
    "landing.faq.a6":
      "Sign in and create one from your account settings. Keys are HMAC-signed, and permissions and rate limits are scoped per key.",
    "landing.faq.q7": "Is this financial advice?",
    "landing.faq.a7":
      "No. Nothing here has monetary value, and nothing here is investment advice.",
    "landing.faq.q8": "What happens if my account is suspended?",
    "landing.faq.a8":
      "Your session ends, open orders are cancelled, and balances are frozen pending review. Suspension is at the operator's discretion under our terms.",

    // terms of use
    "landing.terms.heading": "Terms of use",
    "landing.terms.caption": "the ground rules for this test environment",
    "landing.terms.rule1":
      "This is a closed-loop test environment. All balances are synthetic and have no off-platform value.",
    "landing.terms.rule2":
      "Public accounts have no feature restrictions — full access to spot, futures, options, and swap. Accounts may be suspended at the operator's discretion.",
    "landing.terms.rule3":
      "Data may be reset and is not guaranteed to be retained or backed up.",
    "landing.terms.rule4":
      "No deposits or withdrawals. USDT balances are funded through an internal testnet-mining process.",
    "landing.terms.rule5":
      "API documentation is generated from the code and published via Swagger.",
    "landing.terms.rule6":
      "Rate limits apply per API key; exceeding them may result in the key being revoked.",
    "landing.terms.rule7":
      "No uptime SLA is provided; the engine may be taken offline without notice.",

    // market stats (KPIs)
    "landing.stats.volume24h": "24h Volume",
    "landing.stats.activePairs": "Active Pairs",
    "landing.stats.trades24h": "24h Trades",
    "landing.stats.advancing": "Advancing",
    "landing.stats.declining": "Declining",
    "landing.stats.topGainer": "Top Gainer",

    // markets preview
    "landing.markets.heading": "Markets",
    "landing.markets.allCount": "All {count} markets →",
    "landing.markets.all": "All markets →",
    "landing.markets.tabVolume": "Top Volume",
    "landing.markets.tabGainers": "Gainers",
    "landing.markets.tabLosers": "Losers",

    // movers block
    "landing.movers.topGainers": "Top Gainers",
    "landing.movers.topLosers": "Top Losers",
    "landing.movers.seeAll": "See all →",

    // ticker strip
    "landing.ticker.connecting": "Connecting to market feed…",

    // top markets card
    "landing.topMarkets.title": "Top Markets",
    "landing.topMarkets.allMarkets": "All markets →",
    "landing.topMarkets.colPair": "Pair",
    "landing.topMarkets.colLast": "Last",
    "landing.topMarkets.col24h": "24h",
    "landing.topMarkets.colVol": "Vol",
  },
  ko: {
    "landing.bar.testEnv": "테스트 환경",
    "landing.bar.simulated": "시뮬레이션 현물·선물",
    "landing.bar.synthetic": "합성 잔고 — 입금·출금 불가",
    "landing.bar.openReg": "개방형 가입 · 계정 정지 가능",
    "landing.bar.liquidityLabel": "유동성:",
    "landing.bar.liquidityValue": "ETH 테스트넷 채굴",
    "landing.bar.statusLabel": "상태:",
    "landing.bar.statusValue": "엔진 가동 중",

    "landing.hero.badge": "시뮬레이션 거래소 · 테스트 환경",
    "landing.hero.titleLine1": "전략·봇 테스트를 위한",
    "landing.hero.titleAccent": "시뮬레이션 거래소",
    "landing.hero.titleSuffix": ".",
    "landing.hero.body":
      "실제 매칭엔진 위에서 동작하는 현물·선물 마켓을 합성 잔고로 운영합니다. 트레이딩 전략과 봇을 구축·배포·테스트하세요 — 사람과 자동화 에이전트가 동일한 API, 동일한 거래소를 사용합니다. 가입은 개방되어 있으며, 플랫폼은 Bitninja 팀이 운영합니다.",
    "landing.hero.openTerminal": "트레이딩 터미널 열기",
    "landing.hero.apiDocs": "API 문서",
    "landing.hero.viewMarkets": "마켓 보기 →",
    "landing.hero.note":
      "폐쇄형 테스트 환경입니다. 기준 자산은 ETH 테스트넷 채굴로 조달되는 합성 USDT이며 — 입금·출금이 없고 잔고는 플랫폼 외 가치를 갖지 않습니다.",

    "landing.api.developers": "개발자",
    "landing.api.title": "API로 구축하기",
    "landing.api.body":
      "마켓 데이터, 주문 관리, 계정 작업을 위한 REST 및 WebSocket 엔드포인트를 제공합니다. HMAC-SHA256 요청 서명을 사용하며, 키별로 권한과 요청 한도가 적용됩니다. Swagger로 게시되며, 스키마가 기준입니다.",
    "landing.api.baseUrl": "기본 URL",
    "landing.api.auth": "인증",
    "landing.api.streams": "스트림",
    "landing.api.spec": "스펙",
    "landing.api.openSwagger": "Swagger 열기 →",

    "landing.audience.heading": "이런 분께",
    "landing.audience.caption": "팀 · 에이전트 · 퍼블릭",
    "landing.audience.teamTitle": "팀 & VIP",
    "landing.audience.teamBody":
      "Bitninja 운영 팀과 초대된 VIP 계정. 내부 마켓메이킹, 전략 설계, 수동 마켓 검토를 담당합니다.",
    "landing.audience.agentsTitle": "자동화 에이전트 & 봇",
    "landing.audience.agentsBody":
      "HMAC 서명 API 키로 연결해 상시 운영하세요. 그리드 봇, 마켓메이커, 커스텀 전략을 환영합니다 — 권한과 요청 한도는 키별로 적용됩니다.",
    "landing.audience.publicTitle": "퍼블릭 계정",
    "landing.audience.publicBody":
      "누구나 가입할 수 있으며, 현물·선물·옵션·스왑 등 모든 기능에 전체 접근이 가능합니다. 잔고는 합성이며 플랫폼 외 가치를 갖지 않고, 약관에 따라 계정이 정지될 수 있습니다.",

    "landing.liquidity.heading": "유동성 모델",
    "landing.liquidity.body1":
      "이더리움 테스트넷에서 채굴한 테스트 ETH를 내부 마켓에 매도해 계정 USDT 잔고를 조달합니다. 이를 통해 거래소를 자체 완결적으로 유지하고 외부에서 악용할 유인을 제거합니다.",
    "landing.liquidity.body2":
      "입금과 출금은 지원하지 않습니다. 발행된 유동성과 유통 중인 합성 USDT 간의 비율은 운영자가 주기적으로 재조정합니다.",
    "landing.liquidity.quoteAssetKey": "기준 자산",
    "landing.liquidity.quoteAssetValue": "USDT (합성)",
    "landing.liquidity.sourceKey": "출처",
    "landing.liquidity.sourceValue": "ETH 테스트넷 채굴 → 내부 마켓",
    "landing.liquidity.rebalancingKey": "리밸런싱",
    "landing.liquidity.rebalancingValue": "주기적",
    "landing.liquidity.depositsKey": "입금 / 출금",
    "landing.liquidity.depositsValue": "지원 안 함",
    "landing.liquidity.offPlatformKey": "플랫폼 외 가치",
    "landing.liquidity.offPlatformValue": "없음",

    "landing.faq.heading": "자주 묻는 질문",
    "landing.faq.caption": "이 환경에 대한 일반적인 질문",
    "landing.faq.q1": "Bitshuriken이란?",
    "landing.faq.a1":
      "실제 매칭엔진을 상대로 트레이딩 전략과 봇을 테스트하는 시뮬레이션 현물·선물 거래소입니다. 잔고는 합성이며 플랫폼 외 가치를 갖지 않습니다.",
    "landing.faq.q2": "누가 가입할 수 있나요?",
    "landing.faq.a2":
      "누구나 가능합니다. 가입은 개방되어 있고 퍼블릭 계정도 모든 기능에 전체 접근이 가능합니다. Bitninja 팀과 VIP 계정은 마켓메이킹과 시딩을 위한 상위 운영 권한을 가지며 — 더 높은 기능 등급은 아닙니다.",
    "landing.faq.q3": "무료로 사용할 수 있나요?",
    "landing.faq.a3":
      "네. 비용이 없습니다 — 환경은 내부에서 조달되며 모든 잔고는 합성입니다.",
    "landing.faq.q4": "제 전략이 실제 거래소에서도 통할까요?",
    "landing.faq.a4":
      "엔진은 표준 가격-시간 우선순위와 time-in-force 의미론을 따르므로, 체결이 실제 거래소처럼 동작합니다. 시그널 품질은 여전히 사용자 책임입니다.",
    "landing.faq.q5": "SLA가 있나요?",
    "landing.faq.a5":
      "가동 시간 SLA는 제공하지 않습니다. 이곳은 테스트 환경이며 예고 없이 초기화·재시작·오프라인 전환될 수 있습니다.",
    "landing.faq.q6": "API 키는 어떻게 발급받나요?",
    "landing.faq.a6":
      "로그인 후 계정 설정에서 생성하세요. 키는 HMAC 서명되며, 권한과 요청 한도는 키별로 적용됩니다.",
    "landing.faq.q7": "이것은 투자 조언인가요?",
    "landing.faq.a7":
      "아니요. 이곳의 어떤 것도 금전적 가치가 없으며, 어떤 것도 투자 조언이 아닙니다.",
    "landing.faq.q8": "계정이 정지되면 어떻게 되나요?",
    "landing.faq.a8":
      "세션이 종료되고, 미체결 주문이 취소되며, 잔고는 검토를 위해 동결됩니다. 정지는 약관에 따라 운영자의 재량으로 이루어집니다.",

    "landing.terms.heading": "이용약관",
    "landing.terms.caption": "이 테스트 환경의 기본 규칙",
    "landing.terms.rule1":
      "이곳은 폐쇄형 테스트 환경입니다. 모든 잔고는 합성이며 플랫폼 외 가치를 갖지 않습니다.",
    "landing.terms.rule2":
      "퍼블릭 계정에는 기능 제한이 없습니다 — 현물·선물·옵션·스왑 전체 접근. 계정은 운영자의 재량으로 정지될 수 있습니다.",
    "landing.terms.rule3":
      "데이터는 초기화될 수 있으며 보존이나 백업이 보장되지 않습니다.",
    "landing.terms.rule4":
      "입금·출금이 없습니다. USDT 잔고는 내부 테스트넷 채굴 과정을 통해 조달됩니다.",
    "landing.terms.rule5":
      "API 문서는 코드에서 생성되어 Swagger로 게시됩니다.",
    "landing.terms.rule6":
      "요청 한도는 API 키별로 적용되며, 초과 시 키가 취소될 수 있습니다.",
    "landing.terms.rule7":
      "가동 시간 SLA는 제공되지 않으며, 엔진은 예고 없이 오프라인 전환될 수 있습니다.",

    "landing.stats.volume24h": "24시간 거래량",
    "landing.stats.activePairs": "활성 페어",
    "landing.stats.trades24h": "24시간 체결",
    "landing.stats.advancing": "상승",
    "landing.stats.declining": "하락",
    "landing.stats.topGainer": "최고 상승",

    "landing.markets.heading": "마켓",
    "landing.markets.allCount": "전체 {count}개 마켓 →",
    "landing.markets.all": "전체 마켓 →",
    "landing.markets.tabVolume": "거래량 상위",
    "landing.markets.tabGainers": "상승",
    "landing.markets.tabLosers": "하락",

    "landing.movers.topGainers": "상승 상위",
    "landing.movers.topLosers": "하락 상위",
    "landing.movers.seeAll": "전체 보기 →",

    "landing.ticker.connecting": "마켓 피드에 연결 중…",

    "landing.topMarkets.title": "인기 마켓",
    "landing.topMarkets.allMarkets": "전체 마켓 →",
    "landing.topMarkets.colPair": "페어",
    "landing.topMarkets.colLast": "현재가",
    "landing.topMarkets.col24h": "24시간",
    "landing.topMarkets.colVol": "거래량",
  },
  ja: {
    "landing.bar.testEnv": "テスト環境",
    "landing.bar.simulated": "シミュレーション現物・先物",
    "landing.bar.synthetic": "合成残高 — 入金・出金なし",
    "landing.bar.openReg": "オープン登録 · アカウントは停止対象",
    "landing.bar.liquidityLabel": "流動性:",
    "landing.bar.liquidityValue": "ETHテストネットマイニング",
    "landing.bar.statusLabel": "ステータス:",
    "landing.bar.statusValue": "エンジン稼働中",

    "landing.hero.badge": "シミュレーション取引所 · テスト環境",
    "landing.hero.titleLine1": "戦略・ボットのテストのための",
    "landing.hero.titleAccent": "シミュレーション取引所",
    "landing.hero.titleSuffix": "。",
    "landing.hero.body":
      "実際のマッチングエンジン上で動作する現物・先物マーケットを、合成残高で運用します。トレーディング戦略やボットを構築・デプロイ・テストできます — 人間も自動化エージェントも、同じAPI、同じ取引所を使用します。登録はオープンで、プラットフォームはBitninjaチームが運営しています。",
    "landing.hero.openTerminal": "取引ターミナルを開く",
    "landing.hero.apiDocs": "APIドキュメント",
    "landing.hero.viewMarkets": "マーケットを見る →",
    "landing.hero.note":
      "クローズドループのテスト環境です。クォート資産はETHテストネットマイニングで調達される合成USDTで — 入金・出金はなく、残高にプラットフォーム外の価値はありません。",

    "landing.api.developers": "開発者",
    "landing.api.title": "APIで構築する",
    "landing.api.body":
      "マーケットデータ、注文管理、アカウント操作のためのRESTおよびWebSocketエンドポイントを提供します。HMAC-SHA256リクエスト署名を使用し、キーごとに権限とレート制限が適用されます。Swaggerで公開され、スキーマが基準となります。",
    "landing.api.baseUrl": "ベースURL",
    "landing.api.auth": "認証",
    "landing.api.streams": "ストリーム",
    "landing.api.spec": "仕様",
    "landing.api.openSwagger": "Swaggerを開く →",

    "landing.audience.heading": "こんな方に",
    "landing.audience.caption": "チーム · エージェント · パブリック",
    "landing.audience.teamTitle": "チーム & VIP",
    "landing.audience.teamBody":
      "Bitninja運営チームと招待されたVIPアカウント。内部マーケットメイキング、戦略設計、手動マーケットレビューを担当します。",
    "landing.audience.agentsTitle": "自動化エージェント & ボット",
    "landing.audience.agentsBody":
      "HMAC署名APIキーで接続し、継続的に稼働できます。グリッドボット、マーケットメーカー、カスタム戦略を歓迎します — 権限とレート制限はキーごとに適用されます。",
    "landing.audience.publicTitle": "パブリックアカウント",
    "landing.audience.publicBody":
      "誰でも登録でき、現物・先物・オプション・スワップなどすべての機能にフルアクセスできます。残高は合成でプラットフォーム外の価値はなく、規約に基づきアカウントが停止される場合があります。",

    "landing.liquidity.heading": "流動性モデル",
    "landing.liquidity.body1":
      "Ethereumテストネットでマイニングし、得られたテストETHを内部マーケットに売却して、アカウントのUSDT残高を調達します。これにより取引所を自己完結的に保ち、外部から悪用する動機を排除します。",
    "landing.liquidity.body2":
      "入金と出金はサポートされていません。発行された流動性と流通中の合成USDTの比率は、運営者が定期的にリバランスします。",
    "landing.liquidity.quoteAssetKey": "クォート資産",
    "landing.liquidity.quoteAssetValue": "USDT（合成）",
    "landing.liquidity.sourceKey": "ソース",
    "landing.liquidity.sourceValue": "ETHテストネットマイニング → 内部マーケット",
    "landing.liquidity.rebalancingKey": "リバランス",
    "landing.liquidity.rebalancingValue": "定期的",
    "landing.liquidity.depositsKey": "入金 / 出金",
    "landing.liquidity.depositsValue": "非対応",
    "landing.liquidity.offPlatformKey": "プラットフォーム外の価値",
    "landing.liquidity.offPlatformValue": "なし",

    "landing.faq.heading": "よくある質問",
    "landing.faq.caption": "この環境に関するよくある質問",
    "landing.faq.q1": "Bitshurikenとは？",
    "landing.faq.a1":
      "実際のマッチングエンジンを相手にトレーディング戦略やボットをテストするための、シミュレーション現物・先物取引所です。残高は合成で、プラットフォーム外の価値はありません。",
    "landing.faq.q2": "誰が登録できますか？",
    "landing.faq.a2":
      "誰でも可能です。登録はオープンで、パブリックアカウントもすべての機能にフルアクセスできます。BitninjaチームとVIPアカウントはマーケットメイキングとシーディングのための上位運用権限を持ちますが — より高い機能ティアではありません。",
    "landing.faq.q3": "無料で利用できますか？",
    "landing.faq.a3":
      "はい。費用はかかりません — 環境は内部で資金提供され、すべての残高は合成です。",
    "landing.faq.q4": "私の戦略は実際の取引所でも通用しますか？",
    "landing.faq.a4":
      "エンジンは標準的な価格・時間優先と time-in-force のセマンティクスに従うため、約定は本番環境のように動作します。シグナルの品質は引き続きユーザーの責任です。",
    "landing.faq.q5": "SLAはありますか？",
    "landing.faq.a5":
      "稼働時間のSLAは公開していません。ここはテスト環境であり、予告なくリセット・再起動・オフライン化される場合があります。",
    "landing.faq.q6": "APIキーはどうやって取得しますか？",
    "landing.faq.a6":
      "ログインしてアカウント設定から作成してください。キーはHMAC署名され、権限とレート制限はキーごとに適用されます。",
    "landing.faq.q7": "これは投資アドバイスですか？",
    "landing.faq.a7":
      "いいえ。ここにあるものに金銭的価値はなく、投資アドバイスでもありません。",
    "landing.faq.q8": "アカウントが停止されるとどうなりますか？",
    "landing.faq.a8":
      "セッションが終了し、未約定注文がキャンセルされ、残高は審査のため凍結されます。停止は規約に基づき運営者の裁量で行われます。",

    "landing.terms.heading": "利用規約",
    "landing.terms.caption": "このテスト環境の基本ルール",
    "landing.terms.rule1":
      "ここはクローズドループのテスト環境です。すべての残高は合成で、プラットフォーム外の価値はありません。",
    "landing.terms.rule2":
      "パブリックアカウントに機能制限はありません — 現物・先物・オプション・スワップにフルアクセス。アカウントは運営者の裁量で停止される場合があります。",
    "landing.terms.rule3":
      "データはリセットされる場合があり、保持やバックアップは保証されません。",
    "landing.terms.rule4":
      "入金・出金はありません。USDT残高は内部のテストネットマイニングプロセスで調達されます。",
    "landing.terms.rule5":
      "APIドキュメントはコードから生成され、Swaggerで公開されます。",
    "landing.terms.rule6":
      "レート制限はAPIキーごとに適用され、超過するとキーが取り消される場合があります。",
    "landing.terms.rule7":
      "稼働時間のSLAは提供されず、エンジンは予告なくオフライン化される場合があります。",

    "landing.stats.volume24h": "24時間出来高",
    "landing.stats.activePairs": "アクティブペア",
    "landing.stats.trades24h": "24時間約定",
    "landing.stats.advancing": "上昇",
    "landing.stats.declining": "下落",
    "landing.stats.topGainer": "上昇トップ",

    "landing.markets.heading": "マーケット",
    "landing.markets.allCount": "全{count}マーケット →",
    "landing.markets.all": "全マーケット →",
    "landing.markets.tabVolume": "出来高トップ",
    "landing.markets.tabGainers": "上昇",
    "landing.markets.tabLosers": "下落",

    "landing.movers.topGainers": "上昇トップ",
    "landing.movers.topLosers": "下落トップ",
    "landing.movers.seeAll": "すべて見る →",

    "landing.ticker.connecting": "マーケットフィードに接続中…",

    "landing.topMarkets.title": "人気マーケット",
    "landing.topMarkets.allMarkets": "全マーケット →",
    "landing.topMarkets.colPair": "ペア",
    "landing.topMarkets.colLast": "現在値",
    "landing.topMarkets.col24h": "24時間",
    "landing.topMarkets.colVol": "出来高",
  },
  zh: {
    "landing.bar.testEnv": "测试环境",
    "landing.bar.simulated": "模拟现货和合约",
    "landing.bar.synthetic": "合成余额 — 无充值或提现",
    "landing.bar.openReg": "开放注册 · 账户可能被停用",
    "landing.bar.liquidityLabel": "流动性:",
    "landing.bar.liquidityValue": "ETH 测试网挖矿",
    "landing.bar.statusLabel": "状态:",
    "landing.bar.statusValue": "引擎运行中",

    "landing.hero.badge": "模拟交易所 · 测试环境",
    "landing.hero.titleLine1": "用于策略与机器人测试的",
    "landing.hero.titleAccent": "模拟交易所",
    "landing.hero.titleSuffix": "。",
    "landing.hero.body":
      "在真实撮合引擎上运行的现货和合约行情，由合成余额提供资金。构建、部署并测试交易策略与机器人 — 人工与自动化代理使用相同的 API、相同的交易场所。注册开放，平台由 Bitninja 团队运营。",
    "landing.hero.openTerminal": "打开交易终端",
    "landing.hero.apiDocs": "API 文档",
    "landing.hero.viewMarkets": "查看行情 →",
    "landing.hero.note":
      "这是一个闭环测试环境。计价资产是通过 ETH 测试网挖矿提供资金的合成 USDT — 无充值或提现，余额不具备平台外价值。",

    "landing.api.developers": "开发者",
    "landing.api.title": "基于 API 构建",
    "landing.api.body":
      "提供用于行情数据、订单管理和账户操作的 REST 和 WebSocket 接口。采用 HMAC-SHA256 请求签名，并按密钥设置权限和速率限制。以 Swagger 发布，模式即为准则。",
    "landing.api.baseUrl": "基础 URL",
    "landing.api.auth": "认证",
    "landing.api.streams": "数据流",
    "landing.api.spec": "规范",
    "landing.api.openSwagger": "打开 Swagger →",

    "landing.audience.heading": "适合人群",
    "landing.audience.caption": "团队 · 代理 · 公众",
    "landing.audience.teamTitle": "团队 & VIP",
    "landing.audience.teamBody":
      "Bitninja 运营团队和受邀的 VIP 账户。负责内部做市、策略设计和人工行情审核。",
    "landing.audience.agentsTitle": "自动化代理 & 机器人",
    "landing.audience.agentsBody":
      "使用 HMAC 签名的 API 密钥连接并持续运行。欢迎网格机器人、做市商和自定义策略 — 权限和速率限制按密钥设置。",
    "landing.audience.publicTitle": "公众账户",
    "landing.audience.publicBody":
      "任何人都可以注册，并可完整使用所有功能 — 现货、合约、期权和兑换。余额为合成且不具备平台外价值，账户可能根据我们的条款被停用。",

    "landing.liquidity.heading": "流动性模型",
    "landing.liquidity.body1":
      "我们在以太坊测试网上挖矿，并将所得的测试 ETH 卖入内部行情，从而为账户 USDT 余额提供资金。这使交易场所保持自成体系，并消除任何平台外滥用的诱因。",
    "landing.liquidity.body2":
      "不支持充值和提现。铸造的流动性与流通中的合成 USDT 之间的比例由运营方定期再平衡。",
    "landing.liquidity.quoteAssetKey": "计价资产",
    "landing.liquidity.quoteAssetValue": "USDT（合成）",
    "landing.liquidity.sourceKey": "来源",
    "landing.liquidity.sourceValue": "ETH 测试网挖矿 → 内部行情",
    "landing.liquidity.rebalancingKey": "再平衡",
    "landing.liquidity.rebalancingValue": "定期",
    "landing.liquidity.depositsKey": "充值 / 提现",
    "landing.liquidity.depositsValue": "不支持",
    "landing.liquidity.offPlatformKey": "平台外价值",
    "landing.liquidity.offPlatformValue": "无",

    "landing.faq.heading": "常见问题",
    "landing.faq.caption": "关于此环境的常见问题",
    "landing.faq.q1": "什么是 Bitshuriken？",
    "landing.faq.a1":
      "一个模拟现货和合约交易所，用于针对真实撮合引擎测试交易策略和机器人。余额为合成且不具备平台外价值。",
    "landing.faq.q2": "谁可以注册？",
    "landing.faq.a2":
      "任何人。注册开放，公众账户也可完整使用所有功能。Bitninja 团队和 VIP 账户拥有用于做市和注入流动性的更高运营权限 — 而非更高的功能等级。",
    "landing.faq.q3": "使用是免费的吗？",
    "landing.faq.a3":
      "是的。没有费用 — 环境由内部提供资金，所有余额均为合成。",
    "landing.faq.q4": "我的策略能迁移到真实交易所吗？",
    "landing.faq.a4":
      "引擎遵循标准的价格-时间优先和 time-in-force 语义，因此成交行为与生产交易场所一致。信号质量仍由您负责。",
    "landing.faq.q5": "有 SLA 吗？",
    "landing.faq.a5":
      "未公布可用性 SLA。这是一个测试环境，可能在不另行通知的情况下被重置、重启或下线。",
    "landing.faq.q6": "如何获取 API 密钥？",
    "landing.faq.a6":
      "登录后从账户设置中创建。密钥经 HMAC 签名，权限和速率限制按密钥设置。",
    "landing.faq.q7": "这是投资建议吗？",
    "landing.faq.a7":
      "不是。这里的任何内容都不具备货币价值，也不构成投资建议。",
    "landing.faq.q8": "如果我的账户被停用会怎样？",
    "landing.faq.a8":
      "您的会话将结束，当前委托被取消，余额冻结以待审核。停用由运营方根据我们的条款酌情决定。",

    "landing.terms.heading": "使用条款",
    "landing.terms.caption": "此测试环境的基本规则",
    "landing.terms.rule1":
      "这是一个闭环测试环境。所有余额均为合成且不具备平台外价值。",
    "landing.terms.rule2":
      "公众账户没有功能限制 — 可完整使用现货、合约、期权和兑换。账户可能由运营方酌情停用。",
    "landing.terms.rule3":
      "数据可能被重置，不保证保留或备份。",
    "landing.terms.rule4":
      "无充值或提现。USDT 余额通过内部测试网挖矿流程提供资金。",
    "landing.terms.rule5":
      "API 文档由代码生成并通过 Swagger 发布。",
    "landing.terms.rule6":
      "速率限制按 API 密钥设置；超出限制可能导致密钥被吊销。",
    "landing.terms.rule7":
      "不提供可用性 SLA；引擎可能在不另行通知的情况下下线。",

    "landing.stats.volume24h": "24小时成交量",
    "landing.stats.activePairs": "活跃交易对",
    "landing.stats.trades24h": "24小时成交",
    "landing.stats.advancing": "上涨",
    "landing.stats.declining": "下跌",
    "landing.stats.topGainer": "涨幅榜首",

    "landing.markets.heading": "行情",
    "landing.markets.allCount": "全部 {count} 个行情 →",
    "landing.markets.all": "全部行情 →",
    "landing.markets.tabVolume": "成交量排行",
    "landing.markets.tabGainers": "上涨",
    "landing.markets.tabLosers": "下跌",

    "landing.movers.topGainers": "涨幅榜",
    "landing.movers.topLosers": "跌幅榜",
    "landing.movers.seeAll": "查看全部 →",

    "landing.ticker.connecting": "正在连接行情数据…",

    "landing.topMarkets.title": "热门行情",
    "landing.topMarkets.allMarkets": "全部行情 →",
    "landing.topMarkets.colPair": "交易对",
    "landing.topMarkets.colLast": "最新价",
    "landing.topMarkets.col24h": "24小时",
    "landing.topMarkets.colVol": "成交量",
  },
});
