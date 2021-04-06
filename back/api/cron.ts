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
        const cookieService = Container.get(CronService);
        const data = await cookieService.crontabs(
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
        const cookieService = Container.get(CronService);
        const data = await cookieService.create(req.body);
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
        const cookieService = Container.get(CronService);
        const data = await cookieService.run(req.params.id);
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
        const cookieService = Container.get(CronService);
        const data = await cookieService.disabled(req.params.id);
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
        const cookieService = Container.get(CronService);
        const data = await cookieService.enabled(req.params.id);
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
        const cookieService = Container.get(CronService);
        const data = await cookieService.log(req.params.id);
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
        const cookieService = Container.get(CronService);
        const data = await cookieService.update(req.body);
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
        const cookieService = Container.get(CronService);
        const data = await cookieService.remove(req.params.id);
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
        const cookieService = Container.get(CronService);
        const data = await cookieService.import_crontab();
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
        const cookieService = Container.get(CronService);
        const data = await cookieService.get(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
