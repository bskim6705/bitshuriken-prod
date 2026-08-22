import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { SESSION_TTL_MS } from './session.config';

const CACHE_TTL_MS = 30_000; // active 판정 캐시 수명 — revoke 반영 지연 ≤30s (타 앱 기준)
const SWEEP_INTERVAL_MS = 60_000;
const CACHE_MAX = 50_000; // 메모리 상한 — 초과 시 가장 오래된 항목부터 축출

interface CacheEntry {
  active: boolean;
  fetchedAt: number;
}

export interface SessionInfo {
  id: string;
  ip: string;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  current: boolean;
}

/**
 * 서버측 세션 상태 — logout-all / 세션 목록 / 즉시 무효화.
 * 가드가 요청마다 isActive를 호출하므로 30s in-memory 캐시로 DB 부하를 제한한다.
 * 같은 프로세스에서 revoke하면 캐시를 동기 무효화하고, 타 앱(spot/futures)은 캐시 만료로 ≤30s 내 반영.
 */
@Injectable()
export class SessionService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private prisma: PrismaService) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  /** 새 세션 행 생성. JWT 서명 전에 호출해 sid를 토큰에 심는다. */
  async create(userId: string, ip: string, userAgent: string | null): Promise<string> {
    const session = await this.prisma.session.create({
      data: { userId, ip, userAgent, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      select: { id: true },
    });
    this.cache.set(session.id, { active: true, fetchedAt: Date.now() });
    return session.id;
  }

  /** 가드 호출 지점. 캐시 히트 시 DB 미접근. active면 lastSeenAt를 best-effort 갱신. */
  async isActive(sessionId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(sessionId);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.active;

    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, expiresAt: true },
    });
    const active = row !== null && row.revokedAt === null && row.expiresAt.getTime() > now;
    this.put(sessionId, active, now);

    if (active) {
      // lastSeenAt은 캐시 refresh 시점에만 (≤1 write/30s/session/app) — fire-and-forget.
      void this.prisma.session
        .update({ where: { id: sessionId }, data: { lastSeenAt: new Date(now) } })
        .catch(() => undefined);
    }
    return active;
  }

  async list(userId: string, currentSessionId?: string): Promise<SessionInfo[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true },
    });
    return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
  }

  /** userId 소유의 단일 세션 revoke. 소유자 불일치면 아무 것도 안 함(count 0). */
  async revoke(userId: string, sessionId: string): Promise<boolean> {
    const res = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count > 0) this.put(sessionId, false, Date.now());
    return res.count > 0;
  }

  /** 현재 세션만 남기고 전부 revoke (비밀번호 변경 등). */
  async revokeAllExcept(userId: string, keepSessionId: string): Promise<void> {
    const revoked = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, id: { not: keepSessionId } },
      select: { id: true },
    });
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, id: { not: keepSessionId } },
      data: { revokedAt: new Date() },
    });
    const now = Date.now();
    for (const { id } of revoked) this.put(id, false, now);
  }

  /** 전 세션 revoke (비밀번호 재설정 — 지켜야 할 현재 세션 없음). */
  async revokeAll(userId: string): Promise<void> {
    const revoked = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const now = Date.now();
    for (const { id } of revoked) this.put(id, false, now);
  }

  private put(sessionId: string, active: boolean, now: number): void {
    if (this.cache.size >= CACHE_MAX && !this.cache.has(sessionId)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(sessionId, { active, fetchedAt: now });
  }

  private sweep(): void {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [id, entry] of this.cache) {
      if (entry.fetchedAt < cutoff) this.cache.delete(id);
    }
  }
}
