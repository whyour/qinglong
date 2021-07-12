import { Request, Response, NextFunction, Application } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import routes from '../api';
import config from '../config';
import jwt from 'express-jwt';
import fs from 'fs';
import { getToken } from '../config/util';

export default ({ app }: { app: Application }) => {
  app.enable('trust proxy');
  app.use(cors());

  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
  app.use(
    jwt({ secret: config.secret as string, algorithms: ['HS384'] }).unless({
      path: ['/api/login', '/api/crons/status'],
    }),
  );
  app.use((req, res, next) => {
    const data = fs.readFileSync(config.authConfigFile, 'utf8');
    const headerToken = getToken(req);
    if (data) {
      const { token } = JSON.parse(data);
      if (token && headerToken === token) {
        return next();
      }
    }
    if (!headerToken && req.path && req.path === '/api/login') {
      return next();
    }
    const remoteAddress = req.socket.remoteAddress;
    if (
      remoteAddress === '::ffff:127.0.0.1' &&
      req.path === '/api/crons/status'
    ) {
      return next();
    }
    const err: any = new Error('UnauthorizedError');
    err['status'] = 401;
    next(err);
  });
  app.use(config.api.prefix, routes());

  app.use((req, res, next) => {
    const err: any = new Error('Not Found');
    err['status'] = 404;
    next(err);
  });

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
      err: Error & { status: number },
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      res.status(err.status || 500);
      res.json({
        code: err.status || 500,
        message: err.message,
      });
    },
  );
};
