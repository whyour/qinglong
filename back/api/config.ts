import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import { celebrate, Joi } from 'celebrate';
import path, { basename } from 'path';
import { SAMPLE_FILES } from '../config/const';
import { t } from '../shared/i18n';
import ConfigService from '../services/config';
import { writeFileWithLock } from '../shared/utils';
const route = Router();

export default (app: Router) => {
  app.use('/configs', route);

  route.get(
    '/samples',
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
      try {
        const configService = Container.get(ConfigService);
        await configService.getFile(req.query.path as string, res);
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
        // Resolve the final path first, then verify containment with a path
        // separator so sibling dirs (e.g. data/scripts-evil) cannot be reached.
        const isScripts = name.startsWith('data/scripts/');
        const basePath = path.resolve(
          isScripts ? config.scriptPath : config.configPath,
        );
        const cleanName = name.replace(/^data\/scripts\//, '');
        const normalized = path.resolve(basePath, cleanName);
        // Verify the resolved path stays within the allowed directory
        if (normalized !== basePath && !normalized.startsWith(basePath + path.sep)) {
          return res.send({ code: 403, message: t('文件路径无效') });
        }
        // Check blacklist on actual filename (not user input)
        if (config.blackFileList.includes(basename(normalized))) {
          return res.send({ code: 403, message: t('文件无法访问') });
        }
        await writeFileWithLock(normalized, content);
        res.send({ code: 200, message: t('保存成功') });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const configService = Container.get(ConfigService);
        await configService.getFile(req.params.file, res);
      } catch (e) {
        return next(e);
      }
    },
  );
};
