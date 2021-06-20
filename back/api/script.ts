import { getFileContentByName, getLastModifyFilePath } from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs';
import { celebrate, Joi } from 'celebrate';
const route = Router();

export default (app: Router) => {
  app.use('/', route);

  route.get(
    '/scripts/files',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const fileList = fs.readdirSync(config.scriptPath, 'utf-8');
        res.send({
          code: 200,
          data: fileList.map((x) => {
            return { title: x, value: x, key: x };
          }),
        });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/scripts/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const content = getFileContentByName(
          `${config.scriptPath}${req.params.file}`,
        );
        res.send({ code: 200, data: content });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
