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
          data: fileList
            .filter((x) => {
              return !fs.lstatSync(config.scriptPath + x).isDirectory();
            })
            .map((x) => {
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

  route.post(
    '/scripts',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().required(),
        content: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, path, content } = req.body as {
          filename: string;
          path: string;
          content: string;
        };
        if (!path.endsWith('/')) {
          path += '/';
        }
        if (config.writePathList.every((x) => !path.startsWith(x))) {
          return res.send({ code: 400, data: '文件路径错误，可保存目录/ql/scripts、/ql/config、/ql/jbot、/ql/bak' });
        }
        const filePath = `${path}${filename.replace(/\//g, '')}`;
        const bakPath = '/ql/bak';
        if (fs.existsSync(filePath)) {
          if (!fs.existsSync(bakPath)) {
            fs.mkdirSync(bakPath);
          }
          fs.copyFileSync(filePath, bakPath);
        }
        fs.writeFileSync(filePath, content);
        return res.send({ code: 200 });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
