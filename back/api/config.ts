import { getFileContentByName, getLastModifyFilePath } from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
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
          case 'shareCode':
            let shareCodeFile = getLastModifyFilePath(config.shareCodeDir);
            content = getFileContentByName(shareCodeFile);
            break;
          case 'diy':
            content = getFileContentByName(config.diyFile);
            break;
          default:
            break;
        }
        res.send({ code: 200, content });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
