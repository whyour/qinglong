import { Joi, celebrate } from 'celebrate';
import { NextFunction, Request, Response, Router } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import GlobalSshKeyService from '../services/globalSshKey';
const route = Router();

export default (app: Router) => {
  app.use('/sshKeys', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const globalSshKeyService = Container.get(GlobalSshKeyService);
      const data = await globalSshKeyService.list(
        req.query.searchValue as string,
      );
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
          alias: Joi.string().required(),
          private_key: Joi.string().required(),
          remarks: Joi.string().optional().allow(''),
        }),
      ),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const globalSshKeyService = Container.get(GlobalSshKeyService);
        if (!req.body?.length) {
          return res.send({ code: 400, message: '参数不正确' });
        }
        const data = await globalSshKeyService.create(req.body);
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
        alias: Joi.string().required(),
        private_key: Joi.string().required(),
        remarks: Joi.string().optional().allow('').allow(null),
        id: Joi.number().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const globalSshKeyService = Container.get(GlobalSshKeyService);
        const data = await globalSshKeyService.update(req.body);
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
        const globalSshKeyService = Container.get(GlobalSshKeyService);
        const data = await globalSshKeyService.remove(req.body);
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
        const globalSshKeyService = Container.get(GlobalSshKeyService);
        const data = await globalSshKeyService.disabled(req.body);
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
        const globalSshKeyService = Container.get(GlobalSshKeyService);
        const data = await globalSshKeyService.enabled(req.body);
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
        const globalSshKeyService = Container.get(GlobalSshKeyService);
        const data = await globalSshKeyService.getDb({ id: req.params.id });
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );
};
