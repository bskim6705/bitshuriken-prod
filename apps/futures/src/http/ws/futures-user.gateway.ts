import { WebSocketGateway } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { FuturesListenKeyService } from '../../user-events/futures-listen-key.service';
import {
  FuturesUserEventsService,
  FuturesUserStreamEvent,
} from '../../user-events/futures-user-events.service';
import { WsUserGatewayBase } from '@app/shared/ws/user-gateway.base';

/**
 * Futures user data stream 게이트웨이 (공통은 WsUserGatewayBase).
 * FuturesUserEventsService에 단일 리스너 1개를 등록해 userId별 소켓으로 fanout.
 */
@WebSocketGateway({ path: '/ws/fuser' })
export class WsFuturesUserGateway extends WsUserGatewayBase<FuturesUserStreamEvent> {
  constructor(
    protected readonly jwt: JwtService,
    protected readonly events: FuturesUserEventsService,
    protected readonly listenKeys: FuturesListenKeyService,
  ) {
    super();
  }
}
