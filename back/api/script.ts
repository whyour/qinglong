import {
  fileExist,
  getFileContentByName,
  readDirs,
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

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const result = readDirs(config.scriptPath, config.scriptPath);
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
            message: '文件路径禁止访问',
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
