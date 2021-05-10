import { Request, Response, NextFunction, Application } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import routes from '../api';
import config from '../config';
import jwt from 'express-jwt';
import fs from 'fs';

export default ({ app }: { app: Application }) => {
  app.enable('trust proxy');
  app.use(cors());

  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
  app.use(
    jwt({ secret: config.secret as string, algorithms: ['HS384'] }).unless({
      path: ['/api/login'],
    }),
  );
  app.use((req, res, next) => {
    if (req.url && req.url.includes('/api/login')) {
      return next();
    }
    const data = fs.readFileSync(config.authConfigFile, 'utf8');
    const authHeader = req.headers.authorization;
    if (data) {
      const { token } = JSON.parse(data);
      if (token && authHeader.includes(token)) {
        return next();
      }
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
