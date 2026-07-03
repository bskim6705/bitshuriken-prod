import { SetMetadata } from '@nestjs/common';
import { WEIGHT_METADATA, ORDER_COUNT_METADATA } from './rate-limit.constants';

/** 고정 weight, 또는 요청별 동적 weight(예: depth/klines의 limit 파라미터). */
export type WeightResolver = number | ((req: { query?: Record<string, unknown> }) => number);

/** 엔드포인트의 REQUEST_WEIGHT 비용. 미지정 시 1. */
export const Weight = (weight: WeightResolver) => SetMetadata(WEIGHT_METADATA, weight);

/** 주문 생성 POST가 ORDERS 카운터에 더하는 수 (기본 1). */
export const OrderCount = (n = 1) => SetMetadata(ORDER_COUNT_METADATA, n);
