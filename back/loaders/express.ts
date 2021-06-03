import { Request, Response, NextFunction, Application } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import routes from '../api';
import config from '../config';
import jwt from 'express-jwt';
import fs from 'fs';
import http from 'http';
import expressWs from 'express-ws';
import Logger from './logger';

const excludePath = ['/api/login'];

const auth = (getToken?: jwt.Options['getToken']) =>
  jwt({
    secret: config.secret as string,
    algorithms: ['HS384'],
    getToken,
  });

const getTokenFromReq = (req) => {
  if (
    req.headers.authorization &&
    req.headers.authorization.split(' ')[0] === 'Bearer'
  ) {
    return req.headers.authorization.split(' ')[1];
  } else if (req.query && req.query.token) {
    return req.query.token;
  }
  return null;
};

export default ({ app }: { app: Application }) => {
  const server = http.createServer(app);

  app.listen = function serverListen(...args) {
    return server.listen(...args);
  };

  const wsInstance = expressWs(app, server);

  // server.on('upgrade', function upgrade(request, socket, head) {
  //   const wss = wsInstance.getWss();
  //   auth((req) => {
  //     const searchParams = new URLSearchParams(
  //       req.url.slice(req.url.indexOf('?')),
  //     );
  //     return searchParams.get('token');
  //   })(request, {} as any, (err) => {
  //     Logger.error(err);
  //     if (err) {
  //       socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
  //       socket.destroy();
  //       return;
  //     }

  //     wss.handleUpgrade(request, socket, head, function done(ws) {
  //       wss.emit('connection', ws, request);
  //     });
  //   });
  // });

  app.enable('trust proxy');
  app.use(cors());

  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
  // app.use(
  //   auth(getTokenFromReq).unless({
  //     path: excludePath,
  //   }),
  // );
  // app.use((req, res, next) => {
  //   if (req.url && excludePath.includes(req.path)) {
  //     return next();
  //   }
  //   const data = fs.readFileSync(config.authConfigFile, 'utf8');
  //   const authHeader = getTokenFromReq(req);
  //   if (data) {
  //     const { token } = JSON.parse(data);
  //     if (token && authHeader.includes(token)) {
  //       return next();
  //     }
  //   }
  //   const err: any = new Error('UnauthorizedError');
  //   err['status'] = 401;
  //   next(err);
  // });
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
