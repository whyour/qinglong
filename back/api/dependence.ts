import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import DependenceService from '../services/dependence';
import { Logger } from 'winston';
import { celebrate, Joi } from 'celebrate';
const route = Router();

export default (app: Router) => {
  app.use('/', route);
  route.get(
    '/dependencies',
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
    '/dependencies',
    celebrate({
      body: Joi.array().items(
        Joi.object({
          name: Joi.string().required(),
          type: Joi.number().required(),
          remark: Joi.number().optional().allow(''),
        }),
      ),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.create(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/dependencies',
    celebrate({
      body: Joi.object({
        name: Joi.string().required(),
        _id: Joi.string().required(),
        type: Joi.number().required(),
        remark: Joi.number().optional().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.update(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.delete(
    '/dependencies',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.remove(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.delete(
    '/dependencies/force',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.removeDb(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/dependencies/:id',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.get(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/dependencies/reinstall',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const dependenceService = Container.get(DependenceService);
        const data = await dependenceService.reInstall(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
