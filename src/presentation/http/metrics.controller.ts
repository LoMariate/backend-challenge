import {
  Controller,
  Get,
  Res,
} from '@nestjs/common';

import type { Response } from 'express';

import {
  metricsRegistry,
} from '../../infrastructure/observability/reconciliation.metrics.js';

@Controller('metrics')
export class MetricsController {
  @Get()
  async getMetrics(
    @Res({ passthrough: true })
    response: Response,
  ): Promise<string> {
    response.setHeader(
      'Content-Type',
      metricsRegistry.contentType,
    );

    return metricsRegistry.metrics();
  }
}
