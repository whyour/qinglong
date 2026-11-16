import { executionIdPattern, executionTriggerId, receiptFinishTime } from '../shared/executionIdentity';
import { readDailyResults } from '../shared/legacyDailyStatistics';
import { PendingCronInstall } from '../shared/errors';
import { triggerHistory } from '../shared/triggerHistory';
import { previewSchedule, withNextRun } from '../shared/cronPreview';
import { Router, Request, Response, NextFunction } from 'express';
import { literal, Op } from 'sequelize';
import { Container } from 'typedi';
import { Logger } from 'winston';
import CronService from '../services/cron';
import CronViewService from '../services/cronView';
import { celebrate, Joi } from 'celebrate';
import { commonCronSchema } from '../validation/schedule';
import {
  RunningInstanceModel,
  InstanceStatus,
} from '../data/runningInstance';
import { t } from '../shared/i18n';
import cronClient from '../schedule/client';

const route = Router();

export default (app: Router) => {
  app.use('/crons', route);

  route.use(async (req, res, next) => {
    // Keep stop/status callbacks available even when the scheduler is down.
    if (['POST', 'PUT', 'DELETE'].includes(req.method) &&
      ['/', '/run', '/enable', '/disable', '/views/enable', '/views/disable'].includes(req.path)) {
      try {
        await cronClient.readiness.ensureReady();
      } catch (error) {
        return next(error);
      }
    }
    return next();
  });

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
          return res.send({ code: 400, message: t('参数错误') });
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
      const result = await cronService.crontabs(req.query as any, true);
      return res.send({ code: 200, data: { ...result, data: result.data.map(withNextRun) } });
    } catch (e) {
      logger.error('🔥 error: %o', e);
      return next(e);
    }
  });

  route.get('/preview', celebrate({ query: Joi.object({
    schedule: Joi.string().required(),
  }).unknown(true) }), (req, res) => {
    try {
      const times = previewSchedule(String(req.query.schedule), 3, Date.now());
      return res.send({ code: 200, data: { times, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    } catch {
      return res.status(400).send({ code: 400, message: t('Cron表达式格式有误') });
    }
  });

  route.get(
    '/detail',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.find(req.query as any);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/',
    celebrate({
      body: Joi.object(commonCronSchema),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.create(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        if (e instanceof PendingCronInstall) {
          return res.status(e.status).send({
            code: e.status, message: e.message, data: { id: e.cronId, saved: false },
          });
        }
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
      headers: Joi.object({ 'idempotency-key': Joi.string().guid().optional() }).unknown(true),
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.stop(req.body, req.get('Idempotency-Key'));
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
      query: Joi.object({
        triggerId: Joi.string().max(256).optional(),
        instanceId: Joi.number().integer().positive().optional(),
        previousPath: Joi.string().optional(),
        follow: Joi.boolean().optional(),
        cursor: Joi.string().pattern(/^\d{1,16}\.[a-f0-9]{64}$/).optional(),
        offset: Joi.number().integer().min(0).optional(),
        limit: Joi.number()
          .integer()
          .min(1)
          .max(1024 * 1024)
          .optional(),
        tail: Joi.boolean().optional(),
        t: Joi.string().optional(),
      }).unknown(true),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const result = await cronService.log(req.params.id, {
          triggerId: req.query.triggerId as string | undefined,
          instanceId: req.query.instanceId === undefined ? undefined : Number(req.query.instanceId),
          previousPath: req.query.previousPath as string | undefined,
          follow: req.query.follow as unknown as boolean,
          cursor: req.query.cursor as string | undefined,
          offset: req.query.offset as unknown as number,
          limit: req.query.limit as unknown as number,
          tail: req.query.tail as unknown as boolean,
        });
        return res.send({
          code: 200,
          data: result.content,
          logStatus: result.status,
          logPath: result.logPath,
          triggerId: result.triggerId,
          cursor: result.cursor,
          reset: result.reset,
          offset: result.offset,
          nextOffset: result.nextOffset,
          total: result.total,
          truncated: result.truncated,
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/',
    celebrate({
      body: Joi.object({
        ...commonCronSchema,
        id: Joi.number().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.update(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/',
    celebrate({
      body: Joi.array().min(1).items(Joi.number().integer().positive(), Joi.object({
        id: Joi.number().integer().positive().required(), script: Joi.string().required(),
        revision: Joi.number().integer(), command: Joi.string(), sub_id: Joi.number().integer().allow(null),
      })),
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
        const data = await cronService.importCrontab();
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
        const data = await cronService.getDb({ id: req.params.id }, true);
        return res.send({ code: 200, data: withNextRun(data) });
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
        exit_code: Joi.number().optional().allow(null),
        trigger_stopped: Joi.boolean().optional(),
        execution_id: Joi.string().pattern(executionIdPattern).optional(),
        trigger_id: Joi.string().pattern(/^[a-z0-9-]{1,120}$/).optional(),
      }).oxor('execution_id', 'trigger_id'),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const cronService = Container.get(CronService);
        const { execution_id, ...body } = req.body;
        const data = await cronService.status({
          ...body,
          finished_at: receiptFinishTime(req.get('X-QL-Finished-At')),
          ...(execution_id && { trigger_id: executionTriggerId(execution_id) }),
          status: req.body.status ? parseInt(req.body.status) : undefined,
          pid: req.body.pid ? parseInt(req.body.pid) : undefined,
        });
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get('/:id/daily-results', celebrate({
    params: Joi.object({ id: Joi.number().integer().positive().required() }),
  }), async (req, res, next) => {
    try {
      const data = await readDailyResults(RunningInstanceModel.sequelize!, Number(req.params.id));
      return res.send({ code: 200, data });
    } catch (error) {
      return next(error);
    }
  });

  route.get('/:id/triggers', celebrate({
    params: Joi.object({ id: Joi.number().integer().positive().required() }),
    query: Joi.object({
      offset: Joi.number().integer().min(0),
      limit: Joi.number().integer().min(1).max(26).default(25),
      ids: Joi.array().items(Joi.string().max(256)).min(1).max(25).single(),
      beforeTime: Joi.number().integer().min(0),
      beforeId: Joi.string().max(256),
    }).and('beforeTime', 'beforeId').oxor('offset', 'beforeTime', 'ids').unknown(true),
  }), async (req, res, next) => {
    try {
      const { offset, limit, beforeTime, beforeId, ids } = req.query;
      const history = triggerHistory();
      const before = beforeId ? { time: Number(beforeTime), id: String(beforeId) } : undefined;
      const data = ids
        ? await history.visibleTriggers(Number(req.params.id), ids as string[])
        : await history.recent(Number(req.params.id), Number(offset || 0), Number(limit), before);
      if (req.query.withQueueWait === 'true') {
        const now = Date.now();
        return res.send({ code: 200, data: data.map(row => row.state === 'queued' && row.queued_at != null
          ? { ...row, queue_wait_ms: Math.max(0, (row.dequeued_at ?? now) - row.queued_at) } : row) });
      }
      return res.send({ code: 200, data });
    } catch (err) { next(err); }
  });

  route.get(
    '/:id/instances',
    celebrate({
      // This route historically ignored query parameters. Only validate and
      // apply cursor options when the caller explicitly requests pagination.
      query: Joi.alternatives().conditional(Joi.object({ paged: Joi.valid('true').required() }).unknown(), {
        then: Joi.object({
          limit: Joi.number().integer().min(1).max(100),
          before: Joi.number().integer().positive(),
          ids: Joi.string().pattern(/^\d+(,\d+){0,99}$/),
        }).unknown(true).oxor('ids', 'limit').oxor('ids', 'before'),
        otherwise: Joi.object().unknown(true),
      }),
      params: Joi.object({
        id: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      try {
        // The instance row may retain a provisional end for cleanup after a restart.
        const pending = `EXISTS (SELECT 1 FROM CronTriggers t WHERE t.instance_id=RunningInstance.id
          AND (t.exit_pending=1 OR (t.state='unknown' AND t.reason='restart')))`;
        const paged = req.query.paged === 'true';
        const ids = paged && req.query.ids ? String(req.query.ids).split(',').map(Number) : undefined;
        const limit = paged && !ids ? Number(req.query.limit ?? 25) : undefined;
        const instances = await RunningInstanceModel.findAll({
          attributes: {
            exclude: ['finished_at', 'exit_code'],
            include: [
              [literal(`CASE WHEN ${pending} THEN NULL ELSE finished_at END`), 'finished_at'],
              [literal(`CASE WHEN ${pending} THEN NULL ELSE exit_code END`), 'exit_code'],
            ],
          },
          where: {
            cron_id: req.params.id,
            ...(ids && { id: { [Op.in]: ids } }),
            ...(paged && req.query.before && { id: { [Op.lt]: Number(req.query.before) } }),
          },
          order: paged ? [['id', 'DESC']] : [['started_at', 'DESC'], ['id', 'DESC']],
          ...(limit && { limit: limit + 1 }),
          raw: true,
        });
        if (limit) return res.send({ code: 200, data: instances.slice(0, limit),
          next: instances.length > limit ? instances[limit - 1].id : null });
        return res.send({ code: 200, data: instances });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/:id/instances/:instanceId/stop',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
        instanceId: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number; instanceId: number }>, res: Response, next: NextFunction) => {
      try {
        const cronService = Container.get(CronService);
        const data = await cronService.stopInstance(Number(req.params.id), Number(req.params.instanceId));
        return res.status(data.code).send(data);
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
