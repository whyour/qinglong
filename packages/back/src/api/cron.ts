import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import CronService from '../services/cron';
import CronViewService from '../services/cronView';
import { celebrate, Joi } from 'celebrate';
import cron_parser from 'cron-parser';
const route = Router();

export default (app: Router) => {
  app.use('/crons', route);

  route.get(
    '/views',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const cronViewService = Container.get(CronViewService);
        const data = await cronViewService.list();
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/views',
    celebrate({
      body: Joi.object({
        name: Joi.string().required(),
        sorts: Joi.array().optional().allow(null),
        filters: Joi.array().optional(),
        filterRelation: Joi.string().optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const cronViewService = Container.get(CronViewService);
        const data = await cronViewService.create(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/views',
    celebrate({
      body: Joi.object({
        name: Joi.string().required(),
        id: Joi.number().required(),
        sorts: Joi.array().optional().allow(null),
        filters: Joi.array().optional(),
        filterRelation: Joi.string().optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const cronViewService = Container.get(CronViewService);
        if (req.body.type === 1) {
          return res.send({ code: 400, message: '参数错误' });
        } else {
          const data = await cronViewService.update(req.body);
          return res.send({ code: 200, data });
        }
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/views',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const cronViewService = Container.get(CronViewService);
        const data = await cronViewService.remove(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/views/move',
    celebrate({
      body: Joi.object({
        fromIndex: Joi.number().required(),
        toIndex: Joi.number().required(),
        id: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      try {
        const cronViewService = Container.get(CronViewService);
        const data = await cronViewService.move(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/views/disable',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronViewService = Container.get(CronViewService);
        const data = await cronViewService.disabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/views/enable',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronViewService = Container.get(CronViewService);
        const data = await cronViewService.enabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const cronService = Container.get(CronService);
      const data = await cronService.crontabs(req.query as any);
      return res.send({ code: 200, data });
    } catch (e) {
      logger.error('🔥 error: %o', e);
      return next(e);
    }
  });

  route.post(
    '/',
    celebrate({
      body: Joi.object({
        command: Joi.string().required(),
        schedule: Joi.string().required(),
        name: Joi.string().optional(),
        labels: Joi.array().optional(),
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
        return next(e);
      }
    },
  );

  route.put(
    '/run',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.run(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/stop',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.stop(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/labels',
    celebrate({
      body: Joi.object({
        ids: Joi.array().items(Joi.number().required()),
        labels: Joi.array().items(Joi.string().required()),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.removeLabels(
          req.body.ids,
          req.body.labels,
        );
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/labels',
    celebrate({
      body: Joi.object({
        ids: Joi.array().items(Joi.number().required()),
        labels: Joi.array().items(Joi.string().required()),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.addLabels(req.body.ids, req.body.labels);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/disable',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.disabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/enable',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.enabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:id/log',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.log(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/',
    celebrate({
      body: Joi.object({
        labels: Joi.array().optional().allow(null),
        command: Joi.string().required(),
        schedule: Joi.string().required(),
        name: Joi.string().optional().allow(null),
        id: Joi.number().required(),
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
        return next(e);
      }
    },
  );

  route.delete(
    '/',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.remove(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/pin',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.pin(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/unpin',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.unPin(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/import',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.import_crontab();
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:id',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.getDb({ id: req.params.id });
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/status',
    celebrate({
      body: Joi.object({
        ids: Joi.array().items(Joi.number().required()),
        status: Joi.string().required(),
        pid: Joi.string().optional().allow(null),
        log_path: Joi.string().optional().allow(null),
        last_running_time: Joi.number().optional().allow(null),
        last_execution_time: Joi.number().optional().allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.status({
          ...req.body,
          status: parseInt(req.body.status),
          pid: parseInt(req.body.pid) || '',
        });
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:id/logs',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.logs(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );
};
