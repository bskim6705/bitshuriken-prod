import { readFileSync } from 'node:fs';
import { makeLogger } from '../core/logger';
import type { FlyModel } from '../brain/model';
import { LobLive } from '../trade/lob-live';

/** 리그 슬롯 하나 = 파리 한 마리의 라이브 프로세스. 인자: <slot.json>. SIGTERM/SIGINT → 청산 후 종료. */
export interface SlotFile {
  symbol: string;
  slot: number;
  flyId: string;
  model: FlyModel;
  capital: number;
  statePath: string; // 서브계정 상태 (슬롯 고정, 파리가 바뀌어도 재사용)
  statusPath: string; // 매초 view()
  label: string;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: league/worker <slot.json>');
  process.exit(2);
}
const slot = JSON.parse(readFileSync(file, 'utf8')) as SlotFile;
const log = makeLogger(`fly:${slot.flyId}`);
const live = new LobLive(slot.symbol, { capital: slot.capital, model: slot.model, statePath: slot.statePath, statusPath: slot.statusPath, label: slot.label, log });
let retiring = false;
const retire = (sig: string): void => {
  if (retiring) return;
  retiring = true;
  log.info(`${sig} — retiring (flatten)`);
  void live.retire().then((r) => {
    log.info(r);
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 20_000).unref();
};
process.on('SIGTERM', () => retire('SIGTERM'));
process.on('SIGINT', () => retire('SIGINT'));
live.start().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
