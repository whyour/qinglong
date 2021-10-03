import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import * as fs from 'fs';
import config from '../config';
import UserService from '../services/user';
import { celebrate, Joi } from 'celebrate';
import { getFileContentByName } from '../config/util';
const route = Router();

export default (app: Router) => {
  app.use('/', route);
  route.post(
    '/login',
    celebrate({
      body: Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.login({ ...req.body }, req);
        return res.send(data);
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/logout',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        await userService.logout(req.platform);
        res.send({ code: 200 });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/user',
    celebrate({
      body: Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        await userService.updateUsernameAndPassword(req.body);
        res.send({ code: 200, message: '更新成功' });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/user',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const authInfo = await userService.getUserInfo();
        res.send({
          code: 200,
          data: {
            username: authInfo.username,
            twoFactorActivated: authInfo.twoFactorActivated,
          },
        });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/user/two-factor/init',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.initTwoFactor();
        res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/user/two-factor/active',
    celebrate({
      body: Joi.object({
        code: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.activeTwoFactor(req.body.code);
        res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/user/two-factor/deactive',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.deactiveTwoFactor();
        res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/user/two-factor/login',
    celebrate({
      body: Joi.object({
        code: Joi.string().required(),
        username: Joi.string().required(),
        password: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.twoFactorLogin(req.body, req);
        res.send(data);
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/user/login-log',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.getLoginLog();
        res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/user/notification',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.getNotificationMode();
        res.send({ code: 200, data });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/user/notification',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const result = await userService.updateNotificationMode(req.body);
        res.send(result);
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/system',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const authInfo = await userService.getUserInfo();
        const envDbContent = getFileContentByName(config.envDbFile);

        let isInitialized = true;
        if (
          Object.keys(authInfo).length === 2 &&
          authInfo.username === 'admin' &&
          authInfo.password === 'admin' &&
          envDbContent.length === 0
        ) {
          isInitialized = false;
        }
        res.send({
          code: 200,
          data: {
            isInitialized,
          },
        });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  // 初始化api
  route.put(
    '/init/user',
    celebrate({
      body: Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        await userService.updateUsernameAndPassword(req.body);
        res.send({ code: 200, message: '更新成功' });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/init/notification',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const result = await userService.updateNotificationMode(req.body);
        res.send(result);
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
