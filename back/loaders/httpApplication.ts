import type express from 'express';
import config from '../config';

export async function createHttpApplication(): Promise<express.Application> {
  // Only the HTTP worker needs an Express application and its middleware.
  const [
    { default: createExpress },
    { default: helmet },
    { default: cors },
    { default: compression },
    { monitoringMiddleware },
  ] = await Promise.all([
    import('express'),
    import('helmet'),
    import('cors'),
    import('compression'),
    import('../middlewares/monitoring'),
  ]);
  const app = createExpress();
  app.use((req, res, next) => {
    if (req.query.t) delete req.query.t;
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );
  app.use(cors(config.cors));
  app.use(compression());
  app.use(monitoringMiddleware);
  return app;
}
