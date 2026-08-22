import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MarketType } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { FuturesLedgerModule } from './futures-ledger.module';
import { FuturesLedgerScheduler } from './futures-ledger.scheduler';

// ADR-069 S0 DI 계약: forRoot는 한 번만 호출되고 @Global 재-export로 feature 모듈이 재-import 없이
// 같은 LedgerService/JournalWriter 단일 인스턴스를 주입받는다(원장=앱당 단일 진실). 소유=FUTURES.

@Injectable()
class Consumer {
  constructor(
    public readonly ledger: LedgerService,
    public readonly writer: JournalWriter,
  ) {}
}

// FuturesLedgerModule을 import하지 않는 feature-유사 모듈 — @Global 전파에만 의존.
@Module({ providers: [Consumer] })
class ConsumerModule {}

describe('FuturesLedgerModule (DI wiring)', () => {
  it('feature 모듈이 재-import 없이 동일 LedgerService/JournalWriter 싱글턴을 주입받는다', async () => {
    const journalStub = {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const base = { balanceJournal: journalStub, wallet: { findMany: jest.fn().mockResolvedValue([]) } };
    const prismaStub = { ...base, $transaction: (fn: (tx: typeof base) => unknown) => fn(base) };

    const moduleRef = await Test.createTestingModule({
      imports: [FuturesLedgerModule, ConsumerModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    const ledger = moduleRef.get(LedgerService, { strict: false });
    const consumer = moduleRef.get(Consumer, { strict: false });

    // 싱글턴 — 소유 앱(this)과 feature 모듈이 같은 원장 인스턴스를 본다
    expect(consumer.ledger).toBe(ledger);
    expect(consumer.writer).toBeInstanceOf(JournalWriter);
    expect(moduleRef.get(FuturesLedgerScheduler, { strict: false })).toBeDefined();

    // 소유 마켓 = FUTURES (forRoot 주입 확인)
    expect(ledger.owns(MarketType.FUTURES)).toBe(true);
    expect(ledger.owns(MarketType.SPOT)).toBe(false);
  });
});
