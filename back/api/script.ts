import {
  fileExist,
  getFileContentByName,
  readDirs,
  getLastModifyFilePath,
  readDir,
  emptyDir,
} from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs';
import { celebrate, Joi } from 'celebrate';
import path, { join, parse } from 'path';
import ScriptService from '../services/script';
import multer from 'multer';
const route = Router();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.scriptPath);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage });

export default (app: Router) => {
  app.use('/scripts', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      let result = [];
      const blacklist = ['node_modules', '.git'];
      if (req.query.path) {
        const targetPath = path.join(
          config.scriptPath,
          req.query.path as string,
        );
        result = readDir(targetPath, config.scriptPath, blacklist);
      } else {
        result = readDirs(config.scriptPath, config.scriptPath, blacklist);
      }
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
        return next(e);
      }
    },
  );

  route.post(
    '/',
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
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
          path = `${config.scriptPath}${path}`;
        }
        if (config.writePathList.every((x) => !path.startsWith(x))) {
          return res.send({
            code: 430,
            message: '文件路径禁止访问',
          });
        }

        if (req.file) {
          fs.renameSync(req.file.path, join(path, req.file.filename));
          return res.send({ code: 200 });
        }

        if (directory) {
          fs.mkdirSync(join(path, directory), { recursive: true });
          return res.send({ code: 200 });
        }

        if (!originFilename) {
          originFilename = filename;
        }
        const originFilePath = join(
          path,
          `${originFilename.replace(/\//g, '')}`,
        );
        const filePath = join(path, `${filename.replace(/\//g, '')}`);
        if (fs.existsSync(originFilePath)) {
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
        type: Joi.string().optional()
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, path, type } = req.body as {
          filename: string;
          path: string;
          type: string;
        };
        const filePath = join(config.scriptPath, path, filename);
        if (type === 'directory') {
          emptyDir(filePath);          
        } else {
          fs.unlinkSync(filePath);
        }
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
        const { name, ext } = parse(filename);
        const filePath = join(config.scriptPath, path, `${name}.swap${ext}`);
        fs.writeFileSync(filePath, content || '', { encoding: 'utf8' });

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
        content: Joi.string().optional().allow(''),
        path: Joi.string().optional().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, content, path } = req.body;
        const { name, ext } = parse(filename);
        const filePath = join(config.scriptPath, path, `${name}.swap${ext}`);

        const scriptService = Container.get(ScriptService);
        const result = await scriptService.stopScript(filePath);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );
};
