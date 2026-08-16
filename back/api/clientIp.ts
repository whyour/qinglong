import { NextFunction, Request, Response, Router } from 'express';
import { celebrate, Joi } from 'celebrate';
import {
  diagnoseClientIp,
  getTrustProxyConfig,
  updateTrustProxy,
} from '../shared/trustProxy';

const route = Router();

export default (app: Router) => {
  app.use('/system/client-ip', route);

  route.get(
    '/config',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.send({ code: 200, data: await getTrustProxyConfig() });
      } catch (error) {
        next(error);
      }
    },
  );

  route.put(
    '/config',
    celebrate({
      body: Joi.object({
        trustProxy: Joi.string().max(500).required(),
      }),
    }),
    async (req: Request, res: Response) => {
      try {
        const data = await updateTrustProxy(req.body.trustProxy);
        res.send({ code: 200, data });
      } catch (error) {
        res.send({
          code: 400,
          message: error instanceof Error ? error.message : '配置更新失败',
        });
      }
    },
  );

  route.get(
    '/diagnose',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.send({ code: 200, data: await diagnoseClientIp(req) });
      } catch (error) {
        next(error);
      }
    },
  );
};
