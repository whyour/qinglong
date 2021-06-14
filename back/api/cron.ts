import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import CronService from '../services/cron';
import { celebrate, Joi } from 'celebrate';
import cron_parser from 'cron-parser';
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
        name: Joi.string().optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        if (cron_parser.parseExpression(req.body.schedule).hasNext()) {
          const cronService = Container.get(CronService);
          const data = await cronService.create(req.body);
          return res.send({ code: 200, data });
        } else {
          return res.send({ code: 400, message: 'param schedule error' });
        }
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/crons/run',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.run(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/crons/stop',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.stop(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/crons/disable',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.disabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/crons/enable',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.enabled(req.body);
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
        command: Joi.string().optional(),
        schedule: Joi.string().optional(),
        name: Joi.string().optional(),
        _id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        if (
          !req.body.schedule ||
          cron_parser.parseExpression(req.body.schedule).hasNext()
        ) {
          const cronService = Container.get(CronService);
          const data = await cronService.update(req.body);
          return res.send({ code: 200, data });
        } else {
          return res.send({ code: 400, message: 'param schedule error' });
        }
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.delete(
    '/crons',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.remove(req.body);
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

  route.put(
    '/crons/status',
    celebrate({
      body: Joi.object({
        ids: Joi.array().items(Joi.string().required()),
        status: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.status({
          ...req.body,
          status: parseInt(req.body.status),
        });
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
