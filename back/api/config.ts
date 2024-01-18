import { getFileContentByName, getLastModifyFilePath } from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import { celebrate, Joi } from 'celebrate';
import { join } from 'path';
import { SAMPLE_FILES } from '../config/const';
import got from 'got';
const route = Router();

export default (app: Router) => {
  app.use('/configs', route);

  route.get(
    '/sample',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.send({
          code: 200,
          data: SAMPLE_FILES,
        });
      } catch (e) {
        return next(e);
      }
    },
  );

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
    '/detail',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let content = '';
        const _path = req.query.path as string;
        if (config.blackFileList.includes(_path) || !_path) {
          res.send({ code: 403, message: '文件无法访问' });
        }
        if (_path.startsWith('sample/')) {
          const res = await got.get(
            `https://gitlab.com/whyour/qinglong/-/raw/master/${_path}`,
          );
          content = res.body;
        } else if (_path.startsWith('data/scripts/')) {
          content = await getFileContentByName(join(config.rootPath, _path));
        } else {
          content = await getFileContentByName(join(config.configPath, _path));
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
