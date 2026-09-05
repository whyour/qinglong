import { randomUUID } from 'crypto';
import { resolveFileAccess } from '../shared/fileAccess';
import { fileExist, readDirs, readDir, rmPath, IFile } from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import { celebrate, Joi } from 'celebrate';
import path, { join, parse } from 'path';
import ScriptService from '../services/script';
import { t } from '../shared/i18n';
import multer from 'multer';
import { writeFileWithLock } from '../shared/utils';
const route = Router();

function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return config.writePathList.some((x) =>
    Boolean(resolveFileAccess(x, [resolved], config.blackFileList)),
  );
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.tmpPath);
  },
  filename: function (req, file, cb) {
    cb(null, randomUUID());
  },
});
const upload = multer({ storage: storage });

export default (app: Router) => {
  app.use('/scripts', route);

  route.get(
    '/',
    celebrate({
      query: Joi.object({
        path: Joi.string().optional().allow(''),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let result: IFile[] = [];
        const blacklist = [
          'node_modules',
          '.git',
          '.pnpm',
          'pnpm-lock.yaml',
          'yarn.lock',
          'package-lock.json',
        ];
        if (req.query.path) {
          if (
            !resolveFileAccess(
              config.scriptPath,
              [req.query.path as string],
              config.blackFileList,
            )
          ) {
            return res.send({ code: 403, message: t('暂无权限') });
          }
          result = await readDir(
            req.query.path as string,
            config.scriptPath,
            blacklist,
          );
        } else {
          result = await readDirs(
            config.scriptPath,
            config.scriptPath,
            blacklist,
            (a, b) => {
              if (a.type === b.type) {
                return a.title.localeCompare(b.title);
              } else {
                return a.type === 'directory' ? -1 : 1;
              }
            },
          );
        }
        res.send({
          code: 200,
          data: result,
        });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/detail',
    celebrate({
      query: Joi.object({
        path: Joi.string().optional().allow(''),
        file: Joi.string().required(),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scriptService = Container.get(ScriptService);
        const content = await scriptService.getFile(
          (req.query?.path as string) || '',
          req.query.file as string,
        );
        res.send({ code: 200, data: content });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get('/:file', (req: Request, res: Response) => {
    return res.send({
      code: 410,
      message: t('接口已下线，请使用 /scripts/detail 接口'),
    });
  });

  route.post(
    '/',
    (req: Request, res: Response, next: NextFunction) => {
      res.on('finish', () => {
        if (req.file?.path) fs.unlink(req.file.path).catch(() => undefined);
      });
      next();
    },
    upload.single('file'),
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        content: Joi.string().optional().allow(''),
        originFilename: Joi.string().optional().allow(''),
        directory: Joi.string().optional().allow(''),
        file: Joi.string().optional().allow(''),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path, content, originFilename, directory } =
          req.body as {
            filename: string;
            path: string;
            content: string;
            originFilename: string;
            directory: string;
          };

        if (!path) {
          path = config.scriptPath;
        }
        if (!path.endsWith('/')) {
          path += '/';
        }
        if (!path.startsWith('/')) {
          path = join(config.scriptPath, path);
        }
        if (config.writePathList.every((x) => !path.startsWith(x))) {
          return res.send({
            code: 403,
            message: t('暂无权限'),
          });
        }

        if (req.file) {
          const uploadPath = join(path, filename);
          if (!isPathAllowed(uploadPath)) {
            return res.send({ code: 403, message: t('暂无权限') });
          }
          await fs.copyFile(req.file.path, uploadPath);
          await fs.unlink(req.file.path);
          return res.send({ code: 200 });
        }

        if (directory) {
          const dirPath = join(path, directory);
          if (!isPathAllowed(dirPath)) {
            return res.send({ code: 403, message: t('暂无权限') });
          }
          await fs.mkdir(dirPath, { recursive: true });
          return res.send({ code: 200 });
        }

        if (!originFilename) {
          originFilename = filename;
        }
        const originFilePath = join(path, originFilename);
        const filePath = join(path, filename);
        if (!isPathAllowed(filePath) || !isPathAllowed(originFilePath)) {
          return res.send({ code: 403, message: t('暂无权限') });
        }
        await fs.mkdir(path, { recursive: true });
        const fileExists = await fileExist(filePath);
        if (fileExists) {
          await fs.copyFile(
            originFilePath,
            join(config.bakPath, originFilename.replace(/\//g, '')),
          );
          if (filename !== originFilename) {
            await rmPath(originFilePath);
          }
        }
        await writeFileWithLock(filePath, content);
        return res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        content: Joi.string().required().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, content, path } = req.body as {
          filename: string;
          content: string;
          path: string;
        };
        const scriptService = Container.get(ScriptService);
        const filePath = scriptService.checkFilePath(path, filename);
        if (!filePath) {
          return res.send({
            code: 403,
            message: t('暂无权限'),
          });
        }
        await writeFileWithLock(filePath, content);
        return res.send({ code: 200 });
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
        path: Joi.string().optional().allow(''),
        type: Joi.string().optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        if (!path) {
          path = '';
        }
        const scriptService = Container.get(ScriptService);
        const filePath = scriptService.checkFilePath(path, filename);
        if (!filePath) {
          return res.send({
            code: 403,
            message: t('暂无权限'),
          });
        }
        await rmPath(filePath);
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
        path: Joi.string().optional().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        if (!path) {
          path = '';
        }
        const scriptService = Container.get(ScriptService);
        const filePath = scriptService.checkFilePath(path, filename);
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

  route.put(
    '/run',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        content: Joi.string().optional().allow(''),
        path: Joi.string().optional().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, content, path } = req.body;
        if (!path) {
          path = '';
        }
        const { name, ext } = parse(filename);
        const filePath = join(config.scriptPath, path, `${name}.swap${ext}`);
        if (!isPathAllowed(filePath)) {
          return res.send({ code: 403, message: t('暂无权限') });
        }
        await writeFileWithLock(filePath, content || '');

        const scriptService = Container.get(ScriptService);
        const result = await scriptService.runScript(filePath);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/stop',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        pid: Joi.number().optional().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path, pid } = req.body;
        if (!path) {
          path = '';
        }
        const { name, ext } = parse(filename);
        const filePath = join(config.scriptPath, path, `${name}.swap${ext}`);
        if (!isPathAllowed(filePath)) {
          return res.send({ code: 403, message: t('暂无权限') });
        }
        const logPath = join(config.logPath, path, `${name}.swap`);

        const scriptService = Container.get(ScriptService);
        const result = await scriptService.stopScript(filePath, pid);
        setTimeout(() => {
          rmPath(logPath);
        }, 3000);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/rename',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().allow(''),
        newFilename: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path, newFilename } = req.body as {
          filename: string;
          path: string;
          newFilename: string;
        };
        if (!path) {
          path = '';
        }
        const filePath = join(config.scriptPath, path, filename);
        const newPath = join(config.scriptPath, path, newFilename);
        if (!isPathAllowed(filePath) || !isPathAllowed(newPath)) {
          return res.send({ code: 403, message: t('暂无权限') });
        }
        await fs.rename(filePath, newPath);
        res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );
};
