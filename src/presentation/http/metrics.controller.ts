import {
  Controller,
  Get,
  Res,
} from '@nestjs/common';

import type { Response } from 'express';

import {
  metricsRegistry,
} from '../../infrastructure/observability/reconciliation.metrics.js';

import {
  ObservabilitySampler,
} from '../../infrastructure/observability/observability-sampler.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly sampler: ObservabilitySampler,
  ) {}

  @Get()
  async getMetrics(
    @Res({ passthrough: true })
    response: Response,
  ): Promise<string> {
    await this.sampler.sample();

    response.setHeader(
      'Content-Type',
      metricsRegistry.contentType,
    );

    return metricsRegistry.metrics();
  }
}
