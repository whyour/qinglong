import { getFileContentByName, getLastModifyFilePath } from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs';
import { celebrate, Joi } from 'celebrate';
import { execSync } from 'child_process';
const route = Router();

export default (app: Router) => {
  app.use('/', route);
  route.get(
    '/config/:key',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let content = '未找到文件';
        switch (req.params.key) {
          case 'config':
            content = getFileContentByName(config.confFile);
            break;
          case 'sample':
            content = getFileContentByName(config.sampleFile);
            break;
          case 'crontab':
            content = getFileContentByName(config.crontabFile);
            break;
          case 'extra':
            content = getFileContentByName(config.extraFile);
            break;
          default:
            break;
        }
        res.send({ code: 200, data: content });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/save',
    celebrate({
      body: Joi.object({
        name: Joi.string().required(),
        content: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const { name, content } = req.body;
        const path = (config.fileMap as any)[name];
        fs.writeFileSync(path, content);
        if (name === 'crontab.list') {
          execSync(`crontab ${path}`);
        }
        res.send({ code: 200, msg: '保存成功' });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
