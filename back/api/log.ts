import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import * as fs from 'fs';
import config from '../config';
import { getFileContentByName, readDirs } from '../config/util';
import { join } from 'path';
const route = Router();
const blacklist = ['.tmp'];

export default (app: Router) => {
  app.use('/logs', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const result = readDirs(config.logPath, config.logPath, blacklist);
      res.send({
        code: 200,
        data: result,
      });
    } catch (e) {
      logger.error('🔥 error: %o', e);
      return next(e);
    }
  });

  route.get(
    '/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        if (blacklist.includes(req.path)) {
          return res.send({ code: 403, message: '暂无权限' });
        }
        const filePath = join(
          config.logPath,
          (req.query.path || '') as string,
          req.params.file,
        );
        const content = getFileContentByName(filePath);
        res.send({ code: 200, data: content });
      } catch (e) {
        return next(e);
      }
    },
  );
};
