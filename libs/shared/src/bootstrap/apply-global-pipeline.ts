import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ResponseInterceptor } from '../interceptors/response.interceptor';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { RATE_LIMIT_EXPOSED_HEADERS } from '../rate-limit/rate-limit.constants';
import { loadRateLimitRuntime } from '../rate-limit/rate-limit.config';

/**
 * 5개 앱 공통 부트스트랩: validation / 응답 래핑 / 예외 필터 / 쿠키 / CORS(rate-limit 헤더 노출) / trust-proxy.
 * rate-limit 인터셉터 자체는 RateLimitModule(APP_INTERCEPTOR)에서 DI로 등록된다.
 */
export function applyGlobalPipeline(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.use(cookieParser());

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : false,
    credentials: true,
    // cross-origin FE가 rate-limit 헤더를 읽으려면 반드시 노출.
    exposedHeaders: [...RATE_LIMIT_EXPOSED_HEADERS],
  });

  // trust proxy 기본 0: 역프록시 없는 dev/demo에서 X-Forwarded-For 신뢰 시 req.ip 스푸핑 가능.
  const { trustProxyHops } = loadRateLimitRuntime();
  const instance = app.getHttpAdapter().getInstance() as { set?: (k: string, v: unknown) => void };
  instance.set?.('trust proxy', trustProxyHops);
}
