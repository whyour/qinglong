import { NextFunction, Request, Response, Router } from 'express';
import Container from 'typedi';
import Logger from '../loaders/logger';
import SystemService from '../services/system';
const route = Router();

export default (app: Router) => {
  app.use('/update', route);

  route.put(
    '/reload',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.reloadSystem();
        res.send(result);
      } catch (e) {
        Logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/system',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.reloadSystem('system');
        res.send(result);
      } catch (e) {
        Logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/data',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.reloadSystem('data');
        res.send(result);
      } catch (e) {
        Logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
