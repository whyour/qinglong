import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import EnvService from '../services/env';
import { Logger } from 'winston';
import { celebrate, Joi } from 'celebrate';
import multer from 'multer';
import config from '../config';
import fs from 'fs';
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
  app.use('/envs', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const envService = Container.get(EnvService);
      const data = await envService.envs(req.query.searchValue as string);
      return res.send({ code: 200, data });
    } catch (e) {
      logger.error('🔥 error: %o', e);
      return next(e);
    }
  });

  route.post(
    '/',
    celebrate({
      body: Joi.array().items(
        Joi.object({
          value: Joi.string().required(),
          name: Joi.string().required(),
          remarks: Joi.string().optional().allow(''),
        }),
      ),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.create(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/',
    celebrate({
      body: Joi.object({
        value: Joi.string().required(),
        name: Joi.string().required(),
        remarks: Joi.string().optional().allow('').allow(null),
        id: Joi.number().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.update(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.remove(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/:id/move',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
      }),
      body: Joi.object({
        fromIndex: Joi.number().required(),
        toIndex: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.move(req.params.id, req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/disable',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.disabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/enable',
    celebrate({
      body: Joi.array().items(Joi.number().required()),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.enabled(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/name',
    celebrate({
      body: Joi.object({
        ids: Joi.array().items(Joi.number().required()),
        name: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.updateNames(req.body);
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:id',
    celebrate({
      params: Joi.object({
        id: Joi.number().required(),
      }),
    }),
    async (req: Request<{ id: number }>, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const data = await envService.getDb({ id: req.params.id });
        return res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/upload',
    upload.single('env'),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const envService = Container.get(EnvService);
        const fileContent = await fs.promises.readFile(req!.file!.path, 'utf8');
        const parseContent = JSON.parse(fileContent);
        const data = Array.isArray(parseContent)
          ? parseContent
          : [parseContent];
        if (data.every((x) => x.name && x.value)) {
          const result = await envService.create(
            data.map((x) => ({
              name: x.name,
              value: x.value,
              remarks: x.remarks,
            })),
          );
          return res.send({ code: 200, data: result });
        } else {
          return res.send({
            code: 400,
            message: '文件缺少name或者value字段，参考导出文件格式',
          });
        }
      } catch (e) {
        return next(e);
      }
    },
  );
};
