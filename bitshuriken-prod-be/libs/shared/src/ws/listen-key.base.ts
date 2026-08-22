import { OnModuleDestroy, OnModuleInit, HttpStatus } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import * as crypto from 'crypto';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';

const LISTEN_KEY_BYTES = 32;
const LISTEN_KEY_TTL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface ListenKeyEntry {
  userId: string;
  expiresAt: number; // epoch ms
}

const REVOKED = 'revoked';

/**
 * listenKey 발급/연장/폐기 공통 구현. in-memory Map — 단일 BE 인스턴스 전제.
 * 명시적 revoke와 만료 스윕 양쪽에서 onRevoked를 발화해 게이트웨이가 소켓을 닫게 한다.
 * spot/futures가 각자 @Injectable 서브클래스 인스턴스로 제공.
 */
export abstract class ListenKeyServiceBase implements OnModuleInit, OnModuleDestroy {
  private readonly keys = new Map<string, ListenKeyEntry>();
  private readonly emitter = new EventEmitter();
  private sweepTimer: NodeJS.Timeout | null = null;

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  create(userId: string): string {
    const listenKey = crypto.randomBytes(LISTEN_KEY_BYTES).toString('base64url');
    this.keys.set(listenKey, { userId, expiresAt: Date.now() + LISTEN_KEY_TTL_MS });
    return listenKey;
  }

  /** TTL 60분 재연장. 모르는/만료된 키면 404. */
  keepalive(listenKey: string): void {
    const entry = this.keys.get(listenKey);
    if (!entry)
      throw new DomainException(
        ErrorCode.LISTEN_KEY_NOT_FOUND,
        'Unknown listenKey',
        HttpStatus.NOT_FOUND,
      );
    if (entry.expiresAt <= Date.now()) {
      this.expire(listenKey);
      throw new DomainException(
        ErrorCode.LISTEN_KEY_NOT_FOUND,
        'Unknown listenKey',
        HttpStatus.NOT_FOUND,
      );
    }
    entry.expiresAt = Date.now() + LISTEN_KEY_TTL_MS;
  }

  /** 즉시 만료. 모르는 키는 무시 (멱등). */
  revoke(listenKey: string): void {
    if (!this.keys.delete(listenKey)) return;
    this.emitter.emit(REVOKED, listenKey);
  }

  resolve(listenKey: string): string | null {
    const entry = this.keys.get(listenKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.expire(listenKey);
      return null;
    }
    return entry.userId;
  }

  onRevoked(listener: (listenKey: string) => void): () => void {
    this.emitter.on(REVOKED, listener);
    return () => this.emitter.off(REVOKED, listener);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [listenKey, entry] of this.keys) {
      if (entry.expiresAt <= now) this.expire(listenKey);
    }
  }

  private expire(listenKey: string): void {
    this.keys.delete(listenKey);
    this.emitter.emit(REVOKED, listenKey);
  }
}
