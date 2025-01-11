import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import { getFileContentByName, readDirs, removeAnsi, rmPath } from '../config/util';
import { join, resolve } from 'path';
import { celebrate, Joi } from 'celebrate';
const route = Router();
const blacklist = ['.tmp'];

export default (app: Router) => {
  app.use('/logs', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const result = await readDirs(config.logPath, config.logPath, blacklist);
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
    '/detail',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const finalPath = resolve(
          config.logPath,
          (req.query.path as string) || '',
          (req.query.file as string) || '',
        );

        if (
          blacklist.includes(req.query.path as string) ||
          !finalPath.startsWith(config.logPath)
        ) {
          return res.send({ code: 403, message: '暂无权限' });
        }
        const content = await getFileContentByName(finalPath);
        res.send({ code: 200, data: removeAnsi(content) });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const finalPath = resolve(
          config.logPath,
          (req.query.path as string) || '',
          (req.params.file as string) || '',
        );
        if (
          blacklist.includes(req.path) ||
          !finalPath.startsWith(config.logPath)
        ) {
          return res.send({ code: 403, message: '暂无权限' });
        }
        const content = await getFileContentByName(finalPath);
        res.send({ code: 200, data: content });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().allow(''),
        type: Joi.string().optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path, type } = req.body as {
          filename: string;
          path: string;
          type: string;
        };
        const filePath = join(config.logPath, path, filename);
        await rmPath(filePath);
        res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );
};
