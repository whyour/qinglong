import { randomUUID } from 'crypto';
import { resolveFileAccess } from '../shared/fileAccess';
import { fileExist, readDirs, readDir, rmPath, IFile } from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import { celebrate, Joi } from 'celebrate';
import path, { dirname, join, parse, resolve, sep } from 'path';
import ScriptService from '../services/script';
import ScriptHistoryService from '../services/scriptHistory';
import { t } from '../shared/i18n';
import multer from 'multer';
import { writeFileWithLock } from '../shared/utils';
import {
  ScriptHistoryError,
  HistoryUnavailableError,
} from '../shared/scriptHistory';
const route = Router();

function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return config.writePathList.some((x) =>
    Boolean(
      resolveFileAccess(
        x,
        [resolved],
        // Panel configuration secrets must not restrict user script filenames.
        path.resolve(x) === path.resolve(config.configPath)
          ? config.blackFileList
          : [],
      ),
    ),
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
            !resolveFileAccess(config.scriptPath, [req.query.path as string])
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

  const historyError = (error: unknown, res: Response, next: NextFunction) => {
    if (error instanceof ScriptHistoryError) {
      return res.status(error.status).send({
        code: error.status,
        message: t(error.message),
        ...(error instanceof HistoryUnavailableError
          ? { historyUnavailable: true, currentHash: error.currentHash }
          : {}),
      });
    }
    return next(error);
  };
  const historyQuery = {
    filename: Joi.string().required(),
    path: Joi.string().optional().allow(''),
  };

  route.get(
    '/history',
    celebrate({ query: Joi.object(historyQuery).unknown(true) }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = Container.get(ScriptHistoryService);
        const data = await service.list(
          (req.query.path as string) || '',
          req.query.filename as string,
        );
        res.send({ code: 200, data });
      } catch (error) {
        historyError(error, res, next);
      }
    },
  );
  route.get(
    '/history/detail',
    celebrate({
      query: Joi.object({
        ...historyQuery,
        id: Joi.string().uuid().required(),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = Container.get(ScriptHistoryService);
        const data = await service.detail(
          (req.query.path as string) || '',
          req.query.filename as string,
          req.query.id as string,
        );
        res.send({ code: 200, data });
      } catch (error) {
        historyError(error, res, next);
      }
    },
  );
  route.put(
    '/history/restore',
    celebrate({
      body: Joi.object({
        ...historyQuery,
        id: Joi.string().uuid().required(),
        expectedHash: Joi.string().hex().length(64).required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { path = '', filename, id, expectedHash } = req.body;
        const service = Container.get(ScriptHistoryService);
        const data = await service.restore(path, filename, id, expectedHash);
        res.send({ code: 200, data });
      } catch (error) {
        historyError(error, res, next);
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
        skipHistory: Joi.boolean().optional(),
        expectedHash: Joi.string()
          .hex()
          .length(64)
          .when('skipHistory', { is: true, then: Joi.required() }),
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
        // Check the canonical parent directly at the directory creation boundary.
        const parentPath = resolve(dirname(filePath));
        let parentCreated = false;
        for (const writableRoot of config.writePathList) {
          const root = resolve(writableRoot);
          const rootPrefix = root.endsWith(sep) ? root : root + sep;
          if (parentPath === root) {
            await fs.mkdir(root, { recursive: true });
          } else if (parentPath.startsWith(rootPrefix)) {
            await fs.mkdir(parentPath, { recursive: true });
          } else {
            continue;
          }
          parentCreated = true;
          break;
        }
        if (!parentCreated) {
          return res.send({ code: 403, message: t('暂无权限') });
        }
        const fileExists = await fileExist(filePath);
        if (fileExists && resolveFileAccess(config.scriptPath, [filePath])) {
          let removeSource = filename !== originFilename;
          if (removeSource) {
            const [originRealPath, targetRealPath] = await Promise.all([
              fs.realpath(originFilePath),
              fs.realpath(filePath),
            ]);
            // Aliases of one script are an in-place save. Removing the source
            // would also remove the destination behind a target symlink.
            removeSource = originRealPath !== targetRealPath;
          }
          // Save-as removes the source after committing the destination. Keep
          // its original content too: destination history only protects the
          // file being overwritten, not the source being deleted.
          if (removeSource) {
            await fs.copyFile(
              originFilePath,
              join(config.bakPath, originFilename.replace(/\//g, '')),
            );
          }
          const service = Container.get(ScriptHistoryService);
          const data = await service.save(path, filename, content, {
            skipHistory: req.body.skipHistory,
            expectedHash: req.body.expectedHash,
          });
          if (removeSource) await rmPath(originFilePath);
          return res.send({ code: 200, data });
        }
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
        return historyError(e, res, next);
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
        skipHistory: Joi.boolean().optional(),
        expectedHash: Joi.string()
          .hex()
          .length(64)
          .when('skipHistory', { is: true, then: Joi.required() }),
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
        const service = Container.get(ScriptHistoryService);
        const data = await service.save(path || '', filename, content, {
          skipHistory: req.body.skipHistory,
          expectedHash: req.body.expectedHash,
        });
        return res.send({ code: 200, data });
      } catch (e) {
        return historyError(e, res, next);
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
        const logPath = resolveFileAccess(config.logPath, [
          path,
          `${name}.swap`,
        ]);
        if (!logPath) {
          return res.send({ code: 403, message: t('暂无权限') });
        }

        const scriptService = Container.get(ScriptService);
        const result = await scriptService.stopScript(filePath, pid);
        setTimeout(() => {
          const cleanupPath = resolveFileAccess(config.logPath, [logPath]);
          if (cleanupPath) {
            void rmPath(cleanupPath);
          }
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
