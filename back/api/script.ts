import { getFileContentByName, getLastModifyFilePath } from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs';
import { celebrate, Joi } from 'celebrate';
const route = Router();

export default (app: Router) => {
  app.use('/', route);

  route.get(
    '/scripts/files',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const fileList = fs.readdirSync(config.scriptPath, 'utf-8');
        res.send({
          code: 200,
          data: fileList
            .filter((x) => {
              return !fs.lstatSync(config.scriptPath + x).isDirectory();
            })
            .map((x) => {
              const statObj = fs.statSync(config.scriptPath + x);
              return { title: x, value: x, key: x, mtime: statObj.mtimeMs };
            }),
        });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/scripts/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const content = getFileContentByName(
          `${config.scriptPath}${req.params.file}`,
        );
        res.send({ code: 200, data: content });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/scripts',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().allow(''),
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
    '/scripts',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        content: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, content } = req.body as {
          filename: string;
          content: string;
        };
        const filePath = `${config.scriptPath}${filename}`;
        fs.writeFileSync(filePath, content);
        return res.send({ code: 200 });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.delete(
    '/scripts',
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
        fs.unlinkSync(filePath);
        res.send({ code: 200 });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.post(
    '/scripts/download',
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
};
