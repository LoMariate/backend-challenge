import {
  Controller,
  Get,
  HttpStatus,
  Res,
} from '@nestjs/common';

import type { Response } from 'express';

import { HealthService } from
  '../../infrastructure/observability/health.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
  ) {}

  @Get('live')
  liveness() {
    return {
      status: 'ok',
    };
  }

  @Get('ready')
  async readiness(
    @Res({ passthrough: true })
    response: Response,
  ) {
    const result = await this.healthService.readiness();

    response.status(
      result.status === 'ok'
        ? HttpStatus.OK
        : HttpStatus.SERVICE_UNAVAILABLE,
    );

    return result;
  }
}
