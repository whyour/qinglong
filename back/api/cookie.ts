import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import CookieService from '../services/cookie';
import { celebrate, Joi } from 'celebrate';
import { Logger } from 'winston';
import { getFileContentByName } from '../config/util';
import config from '../config';
const route = Router();

export default (app: Router) => {
  app.use('/', route);
  route.get(
    '/qrcode',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        if (req) {
          const cookieService = Container.get(CookieService);
          const { shici } = await cookieService.getYiYan();
          return res.status(200).json({ code: 200, data: shici });
        } else {
          return res.status(200).json({ err: 1, msg: 'loginFaild' });
        }
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/cookies',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.getCookies();
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/cookie',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const cookieService = Container.get(CookieService);
        const data = await cookieService.addCookie();
        return res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
