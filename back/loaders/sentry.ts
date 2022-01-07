import { Application } from 'express';
import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';
import Logger from './logger';

export default ({ expressApp }: { expressApp: Application }) => {
  Sentry.init({
    dsn: 'https://f4b5b55fb3c645b29a5dc2d70a1a4ef4@o1098464.ingest.sentry.io/6122819',
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Tracing.Integrations.Express({ app: expressApp }),
    ],

    tracesSampleRate: 1.0,
  });

  expressApp.use(Sentry.Handlers.requestHandler());
  expressApp.use(Sentry.Handlers.tracingHandler());

  Logger.info('✌️ Sentry loaded');
};
