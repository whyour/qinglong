import express, { Request, Response, NextFunction, Application } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import routes from '../api';
import config from '../config';
import jwt, { UnauthorizedError } from 'express-jwt';
import fs from 'fs';
import { getPlatform, getToken } from '../config/util';
import Container from 'typedi';
import OpenService from '../services/open';
import rewrite from 'express-urlrewrite';
import UserService from '../services/user';
import handler from 'serve-handler';
import * as Sentry from '@sentry/node';
import { EnvModel } from '../data/env';
import { errors } from 'celebrate';

export default ({ app }: { app: Application }) => {
  app.enable('trust proxy');
  app.use(cors());
  app.use(`${config.api.prefix}/static`, express.static(config.uploadPath));

  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/open')) {
      next();
    } else {
      return handler(req, res, {
        public: 'static/dist',
        rewrites: [{ source: '**', destination: '/index.html' }],
      });
    }
  });
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

  app.use(
    jwt({
      secret: config.secret as string,
      algorithms: ['HS384'],
    }).unless({
      path: [...config.apiWhiteList, /^\/open\//],
    }),
  );

  app.use((req: Request, res, next) => {
    if (!req.headers) {
      req.platform = 'desktop';
    } else {
      const platform = getPlatform(req.headers['user-agent'] || '');
      req.platform = platform;
    }
    return next();
  });

  app.use(async (req, res, next) => {
    const headerToken = getToken(req);
    if (req.path.startsWith('/open/')) {
      const openService = Container.get(OpenService);
      const doc = await openService.findTokenByValue(headerToken);
      if (doc && doc.tokens && doc.tokens.length > 0) {
        const currentToken = doc.tokens.find((x) => x.value === headerToken);
        const keyMatch = req.path.match(/\/open\/([a-z]+)\/*/);
        const key = keyMatch && keyMatch[1];
        if (
          doc.scopes.includes(key as any) &&
          currentToken &&
          currentToken.expiration >= Math.round(Date.now() / 1000)
        ) {
          return next();
        }
      }
    }

    const originPath = `${req.baseUrl}${req.path === '/' ? '' : req.path}`;
    if (
      !headerToken &&
      originPath &&
      config.apiWhiteList.includes(originPath)
    ) {
      return next();
    }

    const data = fs.readFileSync(config.authConfigFile, 'utf8');
    if (data && headerToken) {
      const { token = '', tokens = {} } = JSON.parse(data);
      if (headerToken === token || tokens[req.platform] === headerToken) {
        return next();
      }
    }

    const errorCode = headerToken ? 'invalid_token' : 'credentials_required';
    const errorMessage = headerToken
      ? 'jwt malformed'
      : 'No authorization token was found';
    const err = new UnauthorizedError(errorCode, { message: errorMessage });
    next(err);
  });

  app.use(async (req, res, next) => {
    if (!['/api/user/init', '/api/user/notification/init'].includes(req.path)) {
      return next();
    }
    const userService = Container.get(UserService);
    const authInfo = await userService.getUserInfo();
    const envCount = await EnvModel.count();

    let isInitialized = true;
    if (
      Object.keys(authInfo).length === 2 &&
      authInfo.username === 'admin' &&
      authInfo.password === 'admin' &&
      envCount === 0
    ) {
      isInitialized = false;
    }

    if (isInitialized) {
      return res.send({ code: 450, message: '未知错误' });
    } else {
      return next();
    }
  });

  app.use(rewrite('/open/*', '/api/$1'));
  app.use(config.api.prefix, routes());

  app.use((req, res, next) => {
    const err: any = new Error('Not Found');
    err['status'] = 404;
    next(err);
  });

  app.use(errors());

  app.use(
    (
      err: Error & { status: number },
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      if (err.name === 'UnauthorizedError') {
        return res
          .status(err.status)
          .send({ code: 401, message: err.message })
          .end();
      }
      return next(err);
    },
  );

  app.use(
    (
      err: Error & { errors: any[] },
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      if (err.name.includes('Sequelize')) {
        return res
          .status(500)
          .send({
            code: 400,
            message: `${err.name} ${err.message}`,
            validation: err.errors,
          })
          .end();
      }
      return next(err);
    },
  );

  app.use(
    Sentry.Handlers.errorHandler({
      shouldHandleError(error) {
        // 排除 SequelizeUniqueConstraintError / NotFound
        return (
          !['SequelizeUniqueConstraintError'].includes(error.name) ||
          !['Not Found'].includes(error.message)
        );
      },
    }),
  );

  app.use(
    (
      err: Error & { status: number },
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      Sentry.captureException(err);

      res.status(err.status || 500);
      res.json({
        code: err.status || 500,
        message: err.message,
      });
    },
  );
};
