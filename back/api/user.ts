import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import UserService from '../services/user';
import { celebrate, Joi } from 'celebrate';
import multer from 'multer';
import path from 'path';
import { v4 as uuidV4 } from 'uuid';
import config from '../config';
const route = Router();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.uploadPath);
  },
  filename: function (req, file, cb) {
    const ext = path.parse(file.originalname).ext;
    const key = uuidV4();
    cb(null, key + ext);
  },
});
const upload = multer({ storage: storage });

export default (app: Router) => {
  app.use('/user', route);

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
        return next(e);
      }
    },
  );

  route.put(
    '/',
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
        return next(e);
      }
    },
  );

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const userService = Container.get(UserService);
      const authInfo = await userService.getUserInfo();
      res.send({
        code: 200,
        data: {
          username: authInfo.username,
          avatar: authInfo.avatar,
          twoFactorActivated: authInfo.twoFactorActivated,
        },
      });
    } catch (e) {
      logger.error('🔥 error: %o', e);
      return next(e);
    }
  });

  route.get(
    '/two-factor/init',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.initTwoFactor();
        res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/two-factor/active',
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
        return next(e);
      }
    },
  );

  route.put(
    '/two-factor/deactive',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.deactiveTwoFactor();
        res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/two-factor/login',
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
        return next(e);
      }
    },
  );

  route.get(
    '/login-log',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.getLoginLog();
        res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/notification',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const data = await userService.getNotificationMode();
        res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/notification',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const result = await userService.updateNotificationMode(req.body);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/init',
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
        return next(e);
      }
    },
  );

  route.put(
    '/notification/init',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const result = await userService.updateNotificationMode(req.body);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/avatar',
    upload.single('avatar'),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const userService = Container.get(UserService);
        const result = await userService.updateAvatar(req.file!.filename);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );
};
