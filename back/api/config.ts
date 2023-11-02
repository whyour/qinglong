import { getFileContentByName, getLastModifyFilePath } from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import { celebrate, Joi } from 'celebrate';
import { join } from 'path';
const route = Router();

export default (app: Router) => {
  app.use('/configs', route);

  route.get(
    '/files',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const fileList = await fs.readdir(config.configPath, 'utf-8');
        res.send({
          code: 200,
          data: fileList
            .filter((x) => !config.blackFileList.includes(x))
            .map((x) => {
              return { title: x, value: x };
            }),
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let content = '';
        if (config.blackFileList.includes(req.params.file)) {
          res.send({ code: 403, message: '文件无法访问' });
        }
        if (req.params.file.includes('sample')) {
          content = await getFileContentByName(
            join(config.samplePath, req.params.file),
          );
        } else {
          content = await getFileContentByName(
            join(config.configPath, req.params.file),
          );
        }
        res.send({ code: 200, data: content });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/save',
    celebrate({
      body: Joi.object({
        name: Joi.string().required(),
        content: Joi.string().allow('').optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const { name, content } = req.body;
        if (config.blackFileList.includes(name)) {
          res.send({ code: 403, message: '文件无法访问' });
        }
        const path = join(config.configPath, name);
        await fs.writeFile(path, content);
        res.send({ code: 200, message: '保存成功' });
      } catch (e) {
        return next(e);
      }
    },
  );
};
