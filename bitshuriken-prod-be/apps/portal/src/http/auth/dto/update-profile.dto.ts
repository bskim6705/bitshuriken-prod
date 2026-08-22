import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiProperty({
    description:
      'Public leaderboard display name. Empty/null clears it (falls back to masked email).',
    required: false,
    nullable: true,
    maxLength: 24,
  })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  displayName?: string | null;
}
