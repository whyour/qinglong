import { Application } from 'express';
import * as Sentry from '@sentry/node';
import Logger from './logger';
import config from '../config';
import fs from 'fs';
import { parseVersion } from '../config/util';

export default async ({ expressApp }: { expressApp: Application }) => {
  const { version } = await parseVersion(config.versionFile);

  Sentry.init({
    ignoreErrors: [
      /SequelizeUniqueConstraintError/i,
      /Validation error/i,
      /UnauthorizedError/i,
      /celebrate request validation failed/i,
    ],
    dsn: 'https://8b5c84cfef3e22541bc84de0ed00497b@o1098464.ingest.sentry.io/6122819',
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.Express({ app: expressApp }),
    ],
    tracesSampleRate: 0.8,
    release: version,
  });

  expressApp.use(Sentry.Handlers.requestHandler());
  expressApp.use(Sentry.Handlers.tracingHandler());

  Logger.info('✌️ Sentry loaded');
  console.log('✌️ Sentry loaded');
};
