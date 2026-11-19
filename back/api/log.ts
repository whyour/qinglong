import { directoryCheckHandler, directoryPageHandler } from '../shared/directoryPageRoute';
import { celebrate, Joi } from 'celebrate';
import { NextFunction, Request, Response, Router } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import { t } from '../shared/i18n';
import {
  readDirs,
  removeAnsi,
  rmPath,
} from '../config/util';
import LogService from '../services/log';
import { InstanceStatus, RunningInstanceModel } from '../data/runningInstance';
import { MAX_LOG_CHUNK_BYTES, readLogChunk } from '../shared/logReader';
import { rateLimit } from 'express-rate-limit';
const route = Router();
const blacklist = ['.tmp'];

export default (app: Router) => {
  app.use('/logs', route);
  route.get('/entries', ...directoryPageHandler(() => config.logPath, blacklist, true));
  route.post('/entries/check', ...directoryCheckHandler(() => config.logPath, blacklist));

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
    celebrate({
      query: Joi.object({
        path: Joi.string().allow('').optional(),
        file: Joi.string().required(),
        follow: Joi.boolean().optional(),
        cursor: Joi.string().pattern(/^\d{1,16}\.[a-f0-9]{64}$/).optional(),
        offset: Joi.number().integer().min(0).optional(),
        limit: Joi.number()
          .integer()
          .min(1)
          .max(MAX_LOG_CHUNK_BYTES)
          .optional(),
        tail: Joi.boolean().optional(),
        t: Joi.string().optional(),
      }).unknown(true),
    }),
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
            message: t('暂无权限'),
          });
        }
        const logPath = `${req.query.path as string}/${req.query.file as string}`;
        const runningInstance = await RunningInstanceModel.findOne({
          where: { log_path: logPath, status: InstanceStatus.running },
        });

        const chunk = await readLogChunk(finalPath, {
          follow: req.query.follow as unknown as boolean,
          cursor: req.query.cursor as string | undefined,
          offset: req.query.offset as unknown as number,
          limit: req.query.limit as unknown as number,
          tail: req.query.tail as unknown as boolean,
        });
        res.send({
          code: 200,
          data: req.query.follow ? chunk.content : removeAnsi(chunk.content),
          logStatus: runningInstance ? 'running' : undefined,
          cursor: chunk.cursor,
          reset: chunk.reset,
          offset: chunk.offset,
          nextOffset: chunk.nextOffset,
          total: chunk.total,
          truncated: chunk.truncated,
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:file',
    (req: Request, res: Response) => {
      return res.send({
        code: 410,
        message: t('接口已下线，请使用 /logs/detail 接口'),
      });
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
            message: t('暂无权限'),
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
    rateLimit({ windowMs: 60 * 1000, limit: 600 }),
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
            message: t('暂无权限'),
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
