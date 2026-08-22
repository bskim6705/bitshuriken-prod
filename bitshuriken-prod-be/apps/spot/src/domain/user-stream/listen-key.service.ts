import { Injectable } from '@nestjs/common';
import { ListenKeyServiceBase } from '@app/shared/ws/listen-key.base';

/** spot listenKey 발급/연장/폐기. 구현은 ListenKeyServiceBase. */
@Injectable()
export class ListenKeyService extends ListenKeyServiceBase {}
