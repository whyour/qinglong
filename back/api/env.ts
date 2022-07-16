import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import EnvService from '../services/env';
import { Logger } from 'winston';
import { celebrate, Joi } from 'celebrate';
const route = Router();

export default (app: Router) => {
  app.use('/envs', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const envService = Container.get(EnvService);
      const data = await envService.envs(req.query.searchValue as string);
      return res.send({ code: 200, data });
    } catch (e) {
      logger.error('🔥 error: %o', e);
      return next(e);
    }
  });

  route.post(
    '/',
    celebrate({
      body: Joi.array().items(
        Joi.object({
          value: Joi.string().required(),
          name: Joi.string().required(),
          remarks: Joi.string().optional().allow(''),
        }),
      ),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.create(req.body);
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
        value: Joi.string().required(),
        name: Joi.string().required(),
        remarks: Joi.string().optional().allow('').allow(null),
        id: Joi.number().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.update(req.body);
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
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.remove(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/:id/move',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
      }),
      body: Joi.object({
        fromIndex: Joi.number().required(),
        toIndex: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.move(req.params.id, req.body);
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
        const envService = Container.get(EnvService);
        const data = await envService.disabled(req.body);
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
        const envService = Container.get(EnvService);
        const data = await envService.enabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/name',
    celebrate({
      body: Joi.object({
        ids: Joi.array().items(Joi.number().required()),
        name: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.updateNames(req.body);
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
        const envService = Container.get(EnvService);
        const data = await envService.getDb({ id: req.params.id });
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );
};
