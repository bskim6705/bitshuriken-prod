import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient, MarketType, AssetType, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Default to the colocated match repo for dev; override via TICKER_CONFIG_PATH where
// the match source isn't a sibling (containerized/CI — prod seeds via the admin API).
const TICKER_CONFIG_PATH =
  process.env.TICKER_CONFIG_PATH ??
  join(__dirname, '..', '..', 'bitshuriken-prod-match', 'config', 'tickers.json');

interface TickerConfig {
  market: 'spot' | 'futures';
  symbol: string;
  partition: number;
  pricePrecision: number;
  qtyPrecision: number;
}

// 자산 이름 + 타입 메타. 설정 밖에 두는 이유: 단일 소스(tickers.json)는 매칭엔진이
// 읽으므로 이름/타입 같은 표시용 메타까지 싣기 부적절. 여기에 상주.
const ASSET_META: Record<string, { name: string; type: AssetType; precision: number }> = {
  BTC: { name: 'Bitcoin', type: 'CRYPTO', precision: 8 },
  ETH: { name: 'Ethereum', type: 'CRYPTO', precision: 8 },
  SOL: { name: 'Solana', type: 'CRYPTO', precision: 8 },
  XRP: { name: 'Ripple', type: 'CRYPTO', precision: 8 },
  BNB: { name: 'BNB', type: 'CRYPTO', precision: 8 },
  DOGE: { name: 'Dogecoin', type: 'CRYPTO', precision: 8 },
  ADA: { name: 'Cardano', type: 'CRYPTO', precision: 8 },
  AVAX: { name: 'Avalanche', type: 'CRYPTO', precision: 8 },
  LINK: { name: 'Chainlink', type: 'CRYPTO', precision: 8 },
  DOT: { name: 'Polkadot', type: 'CRYPTO', precision: 8 },
  LTC: { name: 'Litecoin', type: 'CRYPTO', precision: 8 },
  ATOM: { name: 'Cosmos', type: 'CRYPTO', precision: 8 },
  TRX: { name: 'TRON', type: 'CRYPTO', precision: 8 },
  ZEC: { name: 'Zcash', type: 'CRYPTO', precision: 8 },
  XLM: { name: 'Stellar', type: 'CRYPTO', precision: 8 },
  BCH: { name: 'Bitcoin Cash', type: 'CRYPTO', precision: 8 },
  HBAR: { name: 'Hedera', type: 'CRYPTO', precision: 8 },
  SUI: { name: 'Sui', type: 'CRYPTO', precision: 8 },
  SHIB: { name: 'Shiba Inu', type: 'CRYPTO', precision: 8 },
  NEAR: { name: 'NEAR Protocol', type: 'CRYPTO', precision: 8 },
  XAUT: { name: 'Tether Gold', type: 'CRYPTO', precision: 8 },
  TAO: { name: 'Bittensor', type: 'CRYPTO', precision: 8 },
  WLD: { name: 'Worldcoin', type: 'CRYPTO', precision: 8 },
  WLFI: { name: 'World Liberty Financial', type: 'CRYPTO', precision: 8 },
  PAXG: { name: 'PAX Gold', type: 'CRYPTO', precision: 8 },
  UNI: { name: 'Uniswap', type: 'CRYPTO', precision: 8 },
  ONDO: { name: 'Ondo', type: 'CRYPTO', precision: 8 },
  ASTER: { name: 'Aster', type: 'CRYPTO', precision: 8 },
  SKY: { name: 'Sky', type: 'CRYPTO', precision: 8 },
  MORPHO: { name: 'Morpho', type: 'CRYPTO', precision: 8 },
  ICP: { name: 'Internet Computer', type: 'CRYPTO', precision: 8 },
  PEPE: { name: 'Pepe', type: 'CRYPTO', precision: 8 },
  ETC: { name: 'Ethereum Classic', type: 'CRYPTO', precision: 8 },
  AAVE: { name: 'Aave', type: 'CRYPTO', precision: 8 },
  QNT: { name: 'Quant', type: 'CRYPTO', precision: 8 },
  ALGO: { name: 'Algorand', type: 'CRYPTO', precision: 8 },
  ENA: { name: 'Ethena', type: 'CRYPTO', precision: 8 },
  RENDER: { name: 'Render', type: 'CRYPTO', precision: 8 },
  NEXO: { name: 'NEXO', type: 'CRYPTO', precision: 8 },
  POL: { name: 'POL (ex-MATIC)', type: 'CRYPTO', precision: 8 },
  JST: { name: 'JUST', type: 'CRYPTO', precision: 8 },
  DEXE: { name: 'DeXe', type: 'CRYPTO', precision: 8 },
  FIL: { name: 'Filecoin', type: 'CRYPTO', precision: 8 },
  JUP: { name: 'Jupiter', type: 'CRYPTO', precision: 8 },
  ARB: { name: 'Arbitrum', type: 'CRYPTO', precision: 8 },
  APT: { name: 'Aptos', type: 'CRYPTO', precision: 8 },
  INJ: { name: 'Injective', type: 'CRYPTO', precision: 8 },
  PUMP: { name: 'Pump.fun', type: 'CRYPTO', precision: 8 },
  NIGHT: { name: 'Midnight', type: 'CRYPTO', precision: 8 },
  DASH: { name: 'Dash', type: 'CRYPTO', precision: 8 },
  USDT: { name: 'Tether', type: 'STABLECOIN', precision: 6 },
  USDC: { name: 'USD Coin', type: 'STABLECOIN', precision: 6 },
};

function parseTickerConfig(): TickerConfig[] {
  const raw = readFileSync(TICKER_CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as { tickers: TickerConfig[] };
  return parsed.tickers;
}

// 보험기금 시스템 유저 — BE 코드의 상수와 동일해야 한다
const INSURANCE_FUND_EMAIL = 'insurance-fund@bitshuriken.internal';

// futures ticker 기대 precision — 엔진 config 드리프트 검증용
const EXPECTED_FUTURES_PRECISION: Record<string, { pricePrecision: number; qtyPrecision: number }> =
  {
    BTCUSDT: { pricePrecision: 1, qtyPrecision: 3 },
    ETHUSDT: { pricePrecision: 2, qtyPrecision: 3 },
    SOLUSDT: { pricePrecision: 2, qtyPrecision: 2 },
    XRPUSDT: { pricePrecision: 4, qtyPrecision: 1 },
    BNBUSDT: { pricePrecision: 2, qtyPrecision: 2 },
    DOGEUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    ADAUSDT: { pricePrecision: 4, qtyPrecision: 0 },
    AVAXUSDT: { pricePrecision: 3, qtyPrecision: 0 },
    LINKUSDT: { pricePrecision: 3, qtyPrecision: 2 },
    DOTUSDT: { pricePrecision: 3, qtyPrecision: 1 },
    LTCUSDT: { pricePrecision: 2, qtyPrecision: 3 },
    ATOMUSDT: { pricePrecision: 3, qtyPrecision: 2 },
    TRXUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    ZECUSDT: { pricePrecision: 2, qtyPrecision: 3 },
    XLMUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    BCHUSDT: { pricePrecision: 2, qtyPrecision: 3 },
    HBARUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    SUIUSDT: { pricePrecision: 4, qtyPrecision: 1 },
    NEARUSDT: { pricePrecision: 3, qtyPrecision: 0 },
    XAUTUSDT: { pricePrecision: 2, qtyPrecision: 3 },
    TAOUSDT: { pricePrecision: 2, qtyPrecision: 3 },
    WLDUSDT: { pricePrecision: 4, qtyPrecision: 0 },
    WLFIUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    PAXGUSDT: { pricePrecision: 2, qtyPrecision: 3 },
    UNIUSDT: { pricePrecision: 3, qtyPrecision: 0 },
    ONDOUSDT: { pricePrecision: 4, qtyPrecision: 1 },
    ASTERUSDT: { pricePrecision: 4, qtyPrecision: 0 },
    SKYUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    MORPHOUSDT: { pricePrecision: 4, qtyPrecision: 1 },
    ICPUSDT: { pricePrecision: 3, qtyPrecision: 0 },
    ETCUSDT: { pricePrecision: 3, qtyPrecision: 2 },
    AAVEUSDT: { pricePrecision: 2, qtyPrecision: 1 },
    QNTUSDT: { pricePrecision: 2, qtyPrecision: 1 },
    ALGOUSDT: { pricePrecision: 4, qtyPrecision: 1 },
    ENAUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    RENDERUSDT: { pricePrecision: 3, qtyPrecision: 1 },
    POLUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    JSTUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    DEXEUSDT: { pricePrecision: 2, qtyPrecision: 2 },
    FILUSDT: { pricePrecision: 3, qtyPrecision: 1 },
    JUPUSDT: { pricePrecision: 4, qtyPrecision: 0 },
    ARBUSDT: { pricePrecision: 5, qtyPrecision: 1 },
    APTUSDT: { pricePrecision: 4, qtyPrecision: 1 },
    INJUSDT: { pricePrecision: 3, qtyPrecision: 1 },
    PUMPUSDT: { pricePrecision: 6, qtyPrecision: 0 },
    NIGHTUSDT: { pricePrecision: 5, qtyPrecision: 0 },
    DASHUSDT: { pricePrecision: 2, qtyPrecision: 3 },
  };

// futures 정책 파라미터 seed 값 (운영 중 DB에서 조정 가능)
const FUTURES_CONFIG_DEFAULTS = {
  maxLeverage: 50,
  mmr: '0.005',
  liquidationFeeRate: '0.005',
  maxNotional: '1000000',
  fundingCap: '0.003',
  priceBandPct: '0.05',
  marketCostBufferPct: '0.005',
  markClampPct: '0.005',
};

// BTCUSDT → { base: 'BTC', quote: 'USDT' }. 지원 quote 중 suffix 매칭.
function splitSymbol(symbol: string): { base: string; quote: string } {
  for (const quote of ['USDT', 'USDC', 'BTC', 'ETH']) {
    if (symbol.endsWith(quote)) {
      return { base: symbol.slice(0, -quote.length), quote };
    }
  }
  throw new Error(`cannot split symbol: ${symbol}`);
}

function toMarketType(market: string): MarketType {
  const normalized = market.toUpperCase();
  if (normalized !== 'SPOT' && normalized !== 'FUTURES') {
    throw new Error(`unknown market: ${market}`);
  }
  return normalized as MarketType;
}

async function main(): Promise<void> {
  const tickerConfigs = parseTickerConfig();

  // 1. Assets — config에 등장한 base/quote로부터 수집
  const assetSymbols = new Set<string>();
  for (const t of tickerConfigs) {
    const { base, quote } = splitSymbol(t.symbol);
    assetSymbols.add(base);
    assetSymbols.add(quote);
  }

  for (const symbol of assetSymbols) {
    const meta = ASSET_META[symbol];
    if (!meta) throw new Error(`missing ASSET_META entry for ${symbol}`);
    await prisma.asset.upsert({
      where: { symbol },
      update: {},
      create: { symbol, ...meta },
    });
  }

  // 2. Tickers — minNotional은 Binance MIN_NOTIONAL 참조값 (스테이블 quote 5, 그 외 제한 없음)
  for (const t of tickerConfigs) {
    const { base, quote } = splitSymbol(t.symbol);
    const marketType = toMarketType(t.market);
    if (t.pricePrecision + t.qtyPrecision > 8) {
      // 엔진 정수 floor와 정산 잠금 회계가 일치하기 위한 전제
      throw new Error(`${t.symbol}: pricePrecision + qtyPrecision must be <= 8`);
    }
    const minNotional = quote === 'USDT' || quote === 'USDC' ? '5' : '0';
    await prisma.ticker.upsert({
      where: { symbol_marketType: { symbol: t.symbol, marketType } },
      // partition도 갱신 — 버킷(0..P-1) 재배정 시 재시드로 기존 ticker 반영
      update: { minNotional, partition: t.partition },
      create: {
        symbol: t.symbol,
        marketType,
        baseAssetSymbol: base,
        quoteAssetSymbol: quote,
        pricePrecision: t.pricePrecision,
        qtyPrecision: t.qtyPrecision,
        minNotional,
        partition: t.partition,
      },
    });
  }

  // 3. Users — 개발용 seed 2명
  const hashedPassword = await bcrypt.hash('password123', 10);
  const alice = await prisma.user.upsert({
    where: { email: 'alice@test.com' },
    update: {},
    create: { email: 'alice@test.com', hashedPassword },
  });
  const bob = await prisma.user.upsert({
    where: { email: 'bob@test.com' },
    update: {},
    create: { email: 'bob@test.com', hashedPassword },
  });

  // Admin 부트스트랩 — 지정 이메일을 ADMIN으로 승격(재실행 시 멱등).
  // 기본 dev admin은 비번도 password123으로 확정(예측 가능). 커스텀 ADMIN_EMAIL(실계정)이면 role만 승격.
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@test.com';
  const isDefaultAdmin = !process.env.ADMIN_EMAIL || process.env.ADMIN_EMAIL === 'admin@test.com';
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: { role: UserRole.ADMIN, ...(isDefaultAdmin ? { hashedPassword } : {}) },
    create: { email: adminEmail, hashedPassword, role: UserRole.ADMIN },
  });

  // 4. Wallets (SPOT) — USDT 기본 + 주요 base 자산 소량
  const walletBases = ['BTC', 'ETH', 'SOL'];
  const wallets: Array<{
    userId: string;
    assetSymbol: string;
    marketType: MarketType;
    balance: string;
  }> = [];
  for (const userId of [alice.id, bob.id]) {
    wallets.push({ userId, assetSymbol: 'USDT', marketType: 'SPOT', balance: '10000000.00000000' });
    for (const base of walletBases) {
      wallets.push({ userId, assetSymbol: base, marketType: 'SPOT', balance: '100.00000000' });
    }
  }

  for (const w of wallets) {
    await prisma.wallet.upsert({
      where: {
        userId_assetSymbol_marketType: {
          userId: w.userId,
          assetSymbol: w.assetSymbol,
          marketType: w.marketType,
        },
      },
      update: {},
      create: w,
    });
  }

  // 5. Futures — ticker precision 검증(ticker row는 위 2번 루프에서 생성됨) + FuturesConfig
  const futuresSymbols = Object.keys(EXPECTED_FUTURES_PRECISION);
  for (const symbol of futuresSymbols) {
    const expected = EXPECTED_FUTURES_PRECISION[symbol];
    const cfg = tickerConfigs.find((t) => t.market === 'futures' && t.symbol === symbol);
    if (!cfg) throw new Error(`missing futures ticker config: ${symbol}`);
    if (
      cfg.pricePrecision !== expected.pricePrecision ||
      cfg.qtyPrecision !== expected.qtyPrecision
    ) {
      throw new Error(
        `futures ${symbol}: precision mismatch (config ${cfg.pricePrecision}/${cfg.qtyPrecision}, expected ${expected.pricePrecision}/${expected.qtyPrecision})`,
      );
    }
    await prisma.futuresConfig.upsert({
      where: { tickerSymbol: symbol },
      update: {},
      create: { tickerSymbol: symbol, ...FUTURES_CONFIG_DEFAULTS },
    });
  }

  // 6. 보험기금 시스템 유저 — bcrypt 형식이 아닌 더미 해시로 로그인 불가
  const insuranceFund = await prisma.user.upsert({
    where: { email: INSURANCE_FUND_EMAIL },
    update: {},
    create: { email: INSURANCE_FUND_EMAIL, hashedPassword: '!system-account-no-login' },
  });
  await prisma.wallet.upsert({
    where: {
      userId_assetSymbol_marketType: {
        userId: insuranceFund.id,
        assetSymbol: 'USDT',
        marketType: 'FUTURES',
      },
    },
    update: {},
    create: {
      userId: insuranceFund.id,
      assetSymbol: 'USDT',
      marketType: 'FUTURES',
      balance: '0',
    },
  });

  console.log(
    `Seed complete: ${assetSymbols.size} assets, ${tickerConfigs.length} tickers, 2 users, ${wallets.length} wallets, ${futuresSymbols.length} futures configs, insurance fund`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
