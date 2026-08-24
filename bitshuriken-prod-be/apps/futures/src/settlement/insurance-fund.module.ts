import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { InsuranceFundService } from './insurance-fund.service';

/**
 * 보험기금 단독 모듈 — 청산/펀딩(API 앱)과 정산 워커(settle 프로세스)가 공유하는 서비스라
 * 워커 모듈에서 분리 (M1: FuturesSettlementModule은 settle 전용이 됨).
 */
@Module({
  imports: [PrismaModule],
  providers: [InsuranceFundService],
  exports: [InsuranceFundService],
})
export class InsuranceFundModule {}
