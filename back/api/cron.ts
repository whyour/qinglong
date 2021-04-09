import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import * as fs from 'fs';
import config from '../config';
import CronService from '../services/cron';
import { celebrate, Joi } from 'celebrate';
const route = Router();

export default (app: Router) => {
  app.use('/', route);
  route.get(
    '/crons',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.crontabs(
          req.query.searchValue as string,
        );
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/crons',
    celebrate({
      body: Joi.object({
        command: Joi.string().required(),
        schedule: Joi.string().required(),
        name: Joi.string(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.create(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/crons/:id/run',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.run(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/crons/:id/disable',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.disabled(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/crons/:id/enable',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.enabled(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/crons/:id/log',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.log(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/crons',
    celebrate({
      body: Joi.object({
        command: Joi.string().required(),
        schedule: Joi.string().required(),
        name: Joi.string(),
        _id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.update(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.delete(
    '/crons/:id',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.remove(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/crons/import',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.import_crontab();
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/crons/:id',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.get(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
