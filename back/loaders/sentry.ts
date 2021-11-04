import { Application } from 'express';
import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';
import Logger from './logger';

export default ({ expressApp }: { expressApp: Application }) => {
  Sentry.init({
    dsn: 'https://e14681bce55f4849b11024a7d424b711@o1051273.ingest.sentry.io/6047906',
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
