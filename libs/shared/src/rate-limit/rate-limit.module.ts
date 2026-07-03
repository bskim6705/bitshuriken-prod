import { DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RATE_LIMIT_CONFIG } from './rate-limit.constants';
import { resolveRateLimitConfig, RateLimitConfig } from './rate-limit.config';
import { RateLimitApp } from './rate-limit.defaults';
import { RateLimitStore, InMemoryRateLimitStore } from './rate-limit.store';
import { RateLimitInterceptor } from './rate-limit.interceptor';

/**
 * Binance 스타일 weight rate-limit. 각 AppModule이 `RateLimitModule.forApp('spot')`로 import.
 * 앱 식별을 코드에서 넘겨 per-app 한도를 선택(.env 아님). 각 앱은 별도 프로세스라 카운터도 앱별 독립.
 */
@Module({})
export class RateLimitModule {
  static forApp(app: RateLimitApp): DynamicModule {
    return {
      module: RateLimitModule,
      providers: [
        { provide: RATE_LIMIT_CONFIG, useFactory: () => resolveRateLimitConfig(app) },
        {
          provide: RateLimitStore,
          useFactory: (config: RateLimitConfig) => new InMemoryRateLimitStore(config.storeMaxKeys),
          inject: [RATE_LIMIT_CONFIG],
        },
        { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
      ],
    };
  }
}
