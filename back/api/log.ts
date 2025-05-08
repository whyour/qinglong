import { celebrate, Joi } from 'celebrate';
import { NextFunction, Request, Response, Router } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import {
  getFileContentByName,
  readDirs,
  removeAnsi,
  rmPath,
} from '../config/util';
import LogService from '../services/log';
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
        const logService = Container.get(LogService);
        const finalPath = logService.checkFilePath(
          (req.query.path as string) || '',
          (req.query.file as string) || '',
        );
        if (!finalPath || blacklist.includes(req.query.path as string)) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
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
        const logService = Container.get(LogService);
        const finalPath = logService.checkFilePath(
          (req.query.path as string) || '',
          (req.query.file as string) || '',
        );
        if (!finalPath || blacklist.includes(req.query.path as string)) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
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
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        const logService = Container.get(LogService);
        const finalPath = logService.checkFilePath(path, filename);
        if (!finalPath || blacklist.includes(path)) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        await rmPath(finalPath);
        res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/download',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        const logService = Container.get(LogService);
        const filePath = logService.checkFilePath(path, filename);
        if (!filePath) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        return res.download(filePath, filename, (err) => {
          if (err) {
            return next(err);
          }
        });
      } catch (e) {
        return next(e);
      }
    },
  );
};
