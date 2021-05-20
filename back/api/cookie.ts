import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import CookieService from '../services/cookie';
import { Logger } from 'winston';
import { celebrate, Joi } from 'celebrate';
const route = Router();

export default (app: Router) => {
  app.use('/', route);
  route.get(
    '/cookies',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.cookies('', { position: -1 }, true);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/cookies',
    celebrate({
      body: Joi.array().items(Joi.string().required()).min(1),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.create(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/cookies',
    celebrate({
      body: Joi.object({
        value: Joi.string().required(),
        _id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.update(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.delete(
    '/cookies',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.remove(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/cookies/:id/move',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
      body: Joi.object({
        fromIndex: Joi.number().required(),
        toIndex: Joi.number().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.move(req.params.id, req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/cookies/:id/refresh',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.refreshCookie(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/cookies/disable',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.disabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/cookies/enable',
    celebrate({
      body: Joi.array().items(Joi.string().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.enabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/cookies/:id',
    celebrate({
      params: Joi.object({
        id: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.get(req.params.id);
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
