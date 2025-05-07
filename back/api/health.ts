import { Router } from 'express';
import Logger from '../loaders/logger';
import { HealthService } from '../services/health';
import Container from 'typedi';
const route = Router();

export default (app: Router) => {
  app.use('/', route);

  route.get('/health', async (req, res) => {
    try {
      const healthService = Container.get(HealthService);
      const health = await healthService.check();
      res.status(200).send({
        code: 200,
        data: health,
      });
    } catch (err: any) {
      Logger.error('Health check failed:', err);
      res.status(500).send({
        code: 500,
        message: 'Health check failed',
        error: err.message,
      });
    }
  });
};
