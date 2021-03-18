import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import * as fs from 'fs';
import config from '../config';
import { getFileContentByName } from '../config/util';
const route = Router();

export default (app: Router) => {
  app.use('/', route);
  route.get(
    '/logs',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const fileList = fs.readdirSync(config.logPath, 'utf-8');
        const dirs = [];
        for (let i = 0; i < fileList.length; i++) {
          const stat = fs.lstatSync(config.logPath + fileList[i]);
          if (stat.isDirectory()) {
            const fileListTmp = fs.readdirSync(
              `${config.logPath}/${fileList[i]}`,
              'utf-8',
            );
            dirs.push({
              name: fileList[i],
              isDir: true,
              files: fileListTmp.reverse(),
            });
          } else {
            dirs.push({
              name: fileList[i],
              isDir: false,
              files: [],
            });
          }
        }
        res.send({ code: 200, dirs });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/logs/:dir/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const { dir, file } = req.params;
        const content = getFileContentByName(
          `${config.logPath}/${dir}/${file}`,
        );
        res.send({ code: 200, data: content });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/logs/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const { file } = req.params;
        const content = getFileContentByName(`${config.logPath}/${file}`);
        res.send({ code: 200, data: content });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
