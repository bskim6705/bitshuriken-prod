import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { PortalLedgerModule } from './portal-ledger.module';

// DI 계약: portal은 저널 append 전용 — @Global 전파로 feature 모듈이 재-import 없이 JournalWriter
// (deps: PrismaService, LedgerAvailability)를 주입받아야 한다 (2026-07-15 부트 DI 실패 재발 방지).
// 원장(LedgerService/Tailer)은 컨테이너에 없어야 한다 — 소유는 spot/futures.

@Injectable()
class Consumer {
  constructor(public readonly writer: JournalWriter) {}
}

// PortalLedgerModule을 import하지 않는 feature-유사 모듈 — @Global 전파에만 의존.
@Module({ providers: [Consumer] })
class ConsumerModule {}

describe('PortalLedgerModule (DI wiring)', () => {
  it('feature 모듈이 재-import 없이 JournalWriter 싱글턴을 받고, 원장 서비스는 미제공', async () => {
    const prismaStub = {
      balanceJournal: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [PortalLedgerModule, ConsumerModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();
    await moduleRef.init(); // availability 부트 프로브 실행 (listen 전 확정 시맨틱)

    const writer = moduleRef.get(JournalWriter, { strict: false });
    const consumer = moduleRef.get(Consumer, { strict: false });
    expect(writer).toBeInstanceOf(JournalWriter);
    expect(consumer.writer).toBe(writer); // @Global 싱글턴 공유

    // 프로브 성공(테이블 존재 stub) → enabled 확정
    const availability = moduleRef.get(LedgerAvailability, { strict: false });
    expect(availability.enabled).toBe(true);

    // portal은 원장 비소유 — LedgerService는 컨테이너에 없다
    expect(() => moduleRef.get(LedgerService, { strict: false })).toThrow();

    await moduleRef.close();
  });
});
