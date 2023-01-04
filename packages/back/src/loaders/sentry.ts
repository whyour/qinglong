import { Application } from 'express';
import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';
import Logger from './logger';
import config from '../config';
import fs from 'fs';
import { parseVersion } from '../config/util';

export default async ({ expressApp }: { expressApp: Application }) => {
  const { version } = await parseVersion(config.versionFile);

  Sentry.init({
    dsn: 'https://f4b5b55fb3c645b29a5dc2d70a1a4ef4@o1098464.ingest.sentry.io/6122819',
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Tracing.Integrations.Express({ app: expressApp }),
    ],
    tracesSampleRate: 0.1,
    release: version,
  });

  expressApp.use(Sentry.Handlers.requestHandler());
  expressApp.use(Sentry.Handlers.tracingHandler());

  Logger.info('✌️ Sentry loaded');
};
