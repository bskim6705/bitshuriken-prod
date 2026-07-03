import { Injectable } from '@nestjs/common';
import { ListenKeyServiceBase } from '@app/shared/ws/listen-key.base';

/** futures listenKey 발급/연장/폐기. 구현은 ListenKeyServiceBase (spot과 별도 인스턴스). */
@Injectable()
export class FuturesListenKeyService extends ListenKeyServiceBase {}
