import {
  fileExist,
  getFileContentByName,
  getLastModifyFilePath,
} from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs';
import { celebrate, Joi } from 'celebrate';
import path, { join } from 'path';
import ScriptService from '../services/script';
const route = Router();

export default (app: Router) => {
  app.use('/scripts', route);

  route.get(
    '/files',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const fileList = fs.readdirSync(config.scriptPath, 'utf-8');

        let result = [];
        for (let i = 0; i < fileList.length; i++) {
          const fileOrDir = fileList[i];
          const fPath = path.join(config.scriptPath, fileOrDir);
          const dirStat = fs.statSync(fPath);
          if (['node_modules'].includes(fileOrDir)) {
            continue;
          }

          if (dirStat.isDirectory()) {
            const childFileList = fs.readdirSync(fPath, 'utf-8');
            let children = [];
            for (let j = 0; j < childFileList.length; j++) {
              const childFile = childFileList[j];
              const sPath = path.join(config.scriptPath, fileOrDir, childFile);
              const _fileExist = await fileExist(sPath);
              if (_fileExist && fs.statSync(sPath).isFile()) {
                const statObj = fs.statSync(sPath);
                children.push({
                  title: childFile,
                  value: childFile,
                  key: `${fileOrDir}/${childFile}`,
                  mtime: statObj.mtimeMs,
                  parent: fileOrDir,
                });
              }
            }
            result.push({
              title: fileOrDir,
              value: fileOrDir,
              key: fileOrDir,
              mtime: dirStat.mtimeMs,
              disabled: true,
              children: children.sort((a, b) => b.mtime - a.mtime),
            });
          } else {
            result.push({
              title: fileOrDir,
              value: fileOrDir,
              key: fileOrDir,
              mtime: dirStat.mtimeMs,
            });
          }
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
    '/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const filePath = join(
          config.scriptPath,
          req.query.path as string,
          req.params.file,
        );
        const content = getFileContentByName(filePath);
        res.send({ code: 200, data: content });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        content: Joi.string().allow(''),
        originFilename: Joi.string().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, path, content, originFilename } = req.body as {
          filename: string;
          path: string;
          content: string;
          originFilename: string;
        };
        if (!path) {
          path = config.scriptPath;
        }
        if (!path.endsWith('/')) {
          path += '/';
        }
        if (!path.startsWith('/')) {
          path = `${config.scriptPath}${path}`;
        }
        if (config.writePathList.every((x) => !path.startsWith(x))) {
          return res.send({
            code: 430,
            data: '文件路径禁止访问',
          });
        }
        if (!originFilename) {
          originFilename = filename;
        }
        const originFilePath = `${path}${originFilename.replace(/\//g, '')}`;
        const filePath = `${path}${filename.replace(/\//g, '')}`;
        if (fs.existsSync(originFilePath)) {
          if (!fs.existsSync(config.bakPath)) {
            fs.mkdirSync(config.bakPath);
          }
          fs.copyFileSync(
            originFilePath,
            `${config.bakPath}${originFilename.replace(/\//g, '')}`,
          );
          if (filename !== originFilename) {
            fs.unlinkSync(originFilePath);
          }
        }
        fs.writeFileSync(filePath, content);
        return res.send({ code: 200 });
      } catch (e) {
        logger.error('🔥 error: %o', e);
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
        content: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, content, path } = req.body as {
          filename: string;
          content: string;
          path: string;
        };
        const filePath = join(config.scriptPath, path, filename);
        fs.writeFileSync(filePath, content);
        return res.send({ code: 200 });
      } catch (e) {
        logger.error('🔥 error: %o', e);
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
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        const filePath = join(config.scriptPath, path, filename);
        fs.unlinkSync(filePath);
        res.send({ code: 200 });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/download',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename } = req.body as {
          filename: string;
        };
        const filePath = `${config.scriptPath}${filename}`;
        // const stats = fs.statSync(filePath);
        // res.set({
        //   'Content-Type': 'application/octet-stream', //告诉浏览器这是一个二进制文件
        //   'Content-Disposition': 'attachment; filename=' + filename, //告诉浏览器这是一个需要下载的文件
        //   'Content-Length': stats.size  //文件大小
        // });
        // fs.createReadStream(filePath).pipe(res);
        return res.download(filePath, filename, (err) => {
          return next(err);
        });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.put(
    '/run',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        const filePath = join(path, filename);
        const scriptService = Container.get(ScriptService);
        const result = await scriptService.runScript(filePath);
        res.send(result);
      } catch (e) {
        logger.error('🔥 error: %o', e);
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
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        const filePath = join(path, filename);
        const scriptService = Container.get(ScriptService);
        const result = await scriptService.stopScript(filePath);
        res.send(result);
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );
};
