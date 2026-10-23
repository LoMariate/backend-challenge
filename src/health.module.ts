import { Module } from '@nestjs/common';

import { HealthController } from
  './presentation/http/health.controller.js';

import { HealthService } from
  './infrastructure/observability/health.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
