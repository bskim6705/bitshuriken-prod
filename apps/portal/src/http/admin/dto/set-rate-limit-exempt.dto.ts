import { IsBoolean } from 'class-validator';

export class SetRateLimitExemptDto {
  @IsBoolean()
  exempt!: boolean;
}
