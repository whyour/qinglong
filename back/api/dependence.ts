import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import DependenceService from '../services/dependence';
import { Logger } from 'winston';
import { celebrate, Joi } from 'celebrate';
const route = Router();

export default (app: Router) => {
  app.use('/dependencies', route);

  route.get(
    '/',
    celebrate({
      query: Joi.object({
        searchValue: Joi.string().optional().allow(''),
        type: Joi.string().optional().allow(''),
        status: Joi.string().optional().allow(''),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.dependencies(req.query as any);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/refresh',
    celebrate({
      body: Joi.object({
        type: Joi.string().valid('nodejs', 'python3').required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const dependenceService = Container.get(DependenceService);
        const { job, accepted } = dependenceService.startRefresh(req.body.type);
        if (!accepted) {
          return res.status(409).send({
            code: 409,
            message: 'Another dependency refresh is already running',
          });
        }
        return res.send({ code: 200, data: job });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/refresh/active',
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const dependenceService = Container.get(DependenceService);
        res.set('Cache-Control', 'no-store');
        return res.send({
          code: 200,
          data: dependenceService.getActiveRefreshJob() || null,
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/refresh/:id',
    celebrate({
      params: Joi.object({ id: Joi.string().uuid().required() }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const dependenceService = Container.get(DependenceService);
        const job = dependenceService.getRefreshJob(req.params.id);
        if (!job) {
          return res.status(404).send({
            code: 404,
            message: 'Dependency refresh job not found',
          });
        }
        res.set('Cache-Control', 'no-store');
        return res.send({ code: 200, data: job });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/',
    celebrate({
      body: Joi.array().items(
        Joi.object({
          name: Joi.string().required(),
          type: Joi.number().required(),
          remark: Joi.string().optional().allow(''),
        }),
      ),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.create(req.body);
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
        name: Joi.string().required(),
        id: Joi.number().required(),
        type: Joi.number().required(),
        remark: Joi.string().optional().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.update(req.body);
        return res.send({ code: 200, data });
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
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.remove(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/force',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.remove(req.body, true);
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
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.getDb({ id: req.params.id });
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/reinstall',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.reInstall(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/cancel',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const dependenceService = Container.get(DependenceService);
        await dependenceService.cancel(req.body);
        return res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );
};
