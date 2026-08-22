import { readFileSync } from 'node:fs';
import { MasterClient, SubaccountClient, exchangeInfo } from '/Users/kitsune/bitshuriken/bitshuriken-prod/bitshuriken-prod-agents/src/core/exchange';
import { config } from '/Users/kitsune/bitshuriken/bitshuriken-prod/bitshuriken-prod-agents/src/config';

// 2026-07-12 사고 복구: cleanup 도구가 취소해버린 라이브 grid(d13695)의 BUY 사다리 240건을
// DB 원장(취소 직전 가격·잔량) 그대로 재배치한다. 전략의 in-memory 상태(onFill 폴링)와 정합.
const SUB_ID = '930039d4-d844-446c-afb5-4288169856b6'; // agent:grid:btcusdt:d13695
const FILE = process.argv[2]!;

async function main() {
  const ladder = JSON.parse(readFileSync(FILE, 'utf8').trim()) as { side: string; price: string; qty: string }[];
  const master = new MasterClient();
  await master.ensureAccount(config.master.email, config.master.password);
  const key = await master.issueApiKey(SUB_ID, 'ladder-restore');
  const client = new SubaccountClient('restore', key);
  const spec = (await exchangeInfo('SPOT')).find((s) => s.symbol === 'BTCUSDT');
  if (!spec) throw new Error('BTCUSDT not listed');
  let ok = 0;
  let skip = 0;
  for (const o of ladder) {
    const price = Number(o.price).toFixed(2);
    const qty = Number(o.qty).toFixed(8);
    if (Number(price) * Number(qty) < 5) {
      skip++;
      continue;
    }
    try {
      await client.placeLimit(spec, o.side as 'BUY' | 'SELL', price, qty);
      ok++;
    } catch (e) {
      console.error(`place ${o.side} ${price} x ${qty} failed:`, (e as Error).message);
      skip++;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  console.log(`restored ${ok}/${ladder.length} ladder orders (${skip} skipped)`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
