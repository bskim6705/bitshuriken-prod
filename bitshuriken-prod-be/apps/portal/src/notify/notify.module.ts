import { Module } from '@nestjs/common';
import { MailModule } from '@app/core-domain/mail/mail.module';
import { SecurityNotifyService } from './security-notify.service';

@Module({
  imports: [MailModule],
  providers: [SecurityNotifyService],
  exports: [SecurityNotifyService],
})
export class NotifyModule {}
