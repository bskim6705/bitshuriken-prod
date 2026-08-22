import { rows, type CheckResult } from './db';

/**
 * F5 — 정산 DLQ. QUARANTINED 이벤트 = 반영되지 않은 금전 이동이므로 존재 자체가 monetary fail
 * (ADR-067). 워커 error 로그·DeadLetter 테이블에 더해, 정합성 측정에서 반드시 눈에 띄게 한다.
 */
export async function runDlq(): Promise<CheckResult[]> {
  let n: number;
  try {
    const r = await rows<{ n: string }>('SELECT count(*)::text AS n FROM "SettlementDeadLetter"');
    n = Number(r[0]?.n ?? 0);
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') {
      // 마이그레이션 전 호환 (undefined_table)
      return [
        {
          name: 'F5 settlement DLQ',
          status: 'warn',
          detail: 'SettlementDeadLetter table missing — run the pending prisma migration',
        },
      ];
    }
    throw e;
  }
  if (n === 0) {
    return [
      { name: 'F5 settlement DLQ empty', status: 'pass', detail: 'no quarantined settlement events' },
    ];
  }
  const samples = await rows<{ sourceKey: string; kind: string; lastError: string }>(
    'SELECT "sourceKey", kind::text AS kind, "lastError" FROM "SettlementDeadLetter" ORDER BY "quarantinedAt" DESC LIMIT 5',
  );
  return [
    {
      name: 'F5 settlement DLQ empty',
      status: 'fail',
      detail: `${n} quarantined settlement event(s) — money movements NOT applied, operator review required`,
      samples: samples.map((s) => `${s.kind} ${s.sourceKey}: ${s.lastError}`),
    },
  ];
}
