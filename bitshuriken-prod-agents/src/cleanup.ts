import { MasterClient, SubaccountClient } from './core/exchange';
import { config } from './config';
import { makeLogger } from './core/logger';

const log = makeLogger('cleanup');

/**
 * crash/중단된 전략이 남긴 잔여 오픈 주문 일괄 정리 (`npm run cleanup`).
 *
 * 전략 러너는 정상 종료 시 자기 주문을 취소하지만, 비정상 종료(crash/kill -9)의 잔여 주문은
 * 미러 호가를 교란한다 — POST_ONLY 미러 메이커는 스테일 잔여 주문을 크로스하지 못해 그 뒤로
 * 호가를 못 깔았던 실사례(2026-07-12, $5.8 먼지 주문이 북 전체를 동결). 전략 세션 사이에
 * 한 번 돌려 마스터 소유 전 서브계정의 오픈 주문을 정리하는 습관용 도구다.
 *
 * 살아있는 에이전트는 건드리지 않는다: agentd가 running으로 관리 중인 서브계정은 제외하고,
 * agentd에 닿을 수 없으면 agentd 소유 라벨(`agent:*`) 전체를 보수적으로 제외한다 — resting
 * ladder(grid 등)를 가진 라이브 전략의 주문을 지우면 조용히 무력화되기 때문.
 */
async function liveAgentSubaccounts(): Promise<{ ids: Set<string>; daemonUp: boolean }> {
  try {
    const res = await fetch(`${config.control.url}/agents`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { data?: { subaccountId: string; status: string }[] };
    return {
      ids: new Set((body.data ?? []).filter((a) => a.status === 'running').map((a) => a.subaccountId)),
      daemonUp: true,
    };
  } catch {
    return { ids: new Set(), daemonUp: false };
  }
}

async function main(): Promise<void> {
  const master = new MasterClient();
  await master.ensureAccount(config.master.email, config.master.password);
  const subs = await master.listSubaccounts();
  const live = await liveAgentSubaccounts();
  if (!live.daemonUp) log.warn('agentd unreachable — skipping ALL `agent:*` subaccounts to be safe');
  log.info(`${subs.length} subaccounts (${live.ids.size} live agents excluded)`);

  let totalOrders = 0;
  let dirtySubs = 0;
  for (const sub of subs) {
    if (live.ids.has(sub.id)) continue; // 라이브 에이전트 — 주문은 전략의 상태다
    if (!live.daemonUp && sub.label?.startsWith('agent:')) continue;
    const key = await master.issueApiKey(sub.id, 'cleanup');
    const client = new SubaccountClient(`cleanup:${sub.label ?? sub.id.slice(0, 6)}`, key);
    const open = await client.openOrders('SPOT');
    if (open.length === 0) continue;
    dirtySubs++;
    const symbols = [...new Set(open.map((o) => o.tickerSymbol).filter((s): s is string => !!s))];
    for (const symbol of symbols) {
      await client.cancelAll('SPOT', symbol).catch((e: Error) => log.warn(`${symbol}: ${e.message}`));
    }
    totalOrders += open.length;
    log.ok(`${sub.label ?? sub.id}: cancelled ${open.length} orders across ${symbols.join(', ')}`);
  }
  log.ok(`done — ${totalOrders} leftover orders cancelled on ${dirtySubs}/${subs.length} subaccounts`);
  process.exit(0);
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
