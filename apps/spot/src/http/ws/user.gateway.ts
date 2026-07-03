import { WebSocketGateway } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { ListenKeyService } from '../../domain/user-stream/listen-key.service';
import { UserStreamEvent, UserStreamService } from '../../domain/user-stream/user-stream.service';
import { WsUserGatewayBase } from '@app/shared/ws/user-gateway.base';

/**
 * Spot user data stream 게이트웨이 (공통은 WsUserGatewayBase).
 * UserStreamService에 단일 리스너 1개를 등록해 userId별 소켓으로 fanout.
 */
@WebSocketGateway({ path: '/ws/user' })
export class WsUserGateway extends WsUserGatewayBase<UserStreamEvent> {
  constructor(
    protected readonly jwt: JwtService,
    protected readonly events: UserStreamService,
    protected readonly listenKeys: ListenKeyService,
  ) {
    super();
  }
}
