import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import OpenService from '../services/open';
import { Logger } from 'winston';
import { celebrate, Joi } from 'celebrate';
const route = Router();

export default (app: Router) => {
  app.use('/', route);
  route.get(
    '/apps',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const openService = Container.get(OpenService);
        const data = await openService.list();
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/apps',
    celebrate({
      body: Joi.object({
        name: Joi.string().optional().allow('').disallow('system'),
        scopes: Joi.array().items(Joi.string().required()),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const openService = Container.get(OpenService);
        const data = await openService.create(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/apps',
    celebrate({
      body: Joi.object({
        name: Joi.string().optional().allow(''),
        scopes: Joi.array().items(Joi.string()),
        id: Joi.number().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const openService = Container.get(OpenService);
        const data = await openService.update(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/apps',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const openService = Container.get(OpenService);
        const data = await openService.remove(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/apps/:id/reset-secret',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const openService = Container.get(OpenService);
        const data = await openService.resetSecret(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/auth/token',
    celebrate({
      query: {
        client_id: Joi.string().required(),
        client_secret: Joi.string().required(),
      },
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const openService = Container.get(OpenService);
        const result = await openService.authToken(req.query as any);
        return res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );
};
