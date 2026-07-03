import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/infra/prisma/prisma.service';

// seed가 생성하는 시스템 유저 (코드 상수 — env 아님)
export const INSURANCE_FUND_EMAIL = 'insurance-fund@bitshuriken.internal';

@Injectable()
export class InsuranceFundService {
  private cachedId: string | null = null;

  constructor(private prisma: PrismaService) {}

  /** 보험기금 유저 id (1회 조회 캐시). 없으면 throw — seed 누락은 운영 오류. */
  async userId(): Promise<string> {
    if (this.cachedId) return this.cachedId;
    const user = await this.prisma.user.findUnique({
      where: { email: INSURANCE_FUND_EMAIL },
      select: { id: true },
    });
    if (!user) {
      throw new Error(
        `insurance fund user not found (${INSURANCE_FUND_EMAIL}) — run prisma db seed`,
      );
    }
    this.cachedId = user.id;
    return user.id;
  }
}
