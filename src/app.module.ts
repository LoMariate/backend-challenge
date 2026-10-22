import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import ormConfig from './mikro-orm.config.js';

import { WalletsModule } from './wallets.module.js';
import { MessagingModule } from './messaging.module.js';
import { WageringModule } from './wagering.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    WalletsModule,
    MessagingModule,
    WageringModule,
  ],
})
export class AppModule {}
