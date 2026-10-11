import { NextFunction, Request, Response, Router } from 'express';
import { celebrate, Joi } from 'celebrate';
import { Container } from 'typedi';
import RetentionService from '../services/retention';
import { MAX_RETENTION_DAYS } from '../shared/retention';

const route = Router();
const policySchema = {
  runningInstanceRetentionDays: Joi.number()
    .integer()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .required(),
  cronStatRetentionDays: Joi.number()
    .integer()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .required(),
};
const cleanupSchema = {
  ...policySchema,
  dependenceCacheTypes: Joi.array()
    .items(Joi.string().valid('node', 'python3'))
    .unique()
    .default([]),
  compactDatabase: Joi.boolean().default(false),
};

export default (app: Router) => {
  app.use('/system/storage-retention', route);

  route.put(
    '/config',
    celebrate({ body: Joi.object(policySchema) }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = Container.get(RetentionService);
        const data = await service.updatePolicy(req.body);
        res.send({ code: 200, data });
      } catch (error) {
        next(error);
      }
    },
  );

  route.post(
    '/preview',
    celebrate({ body: Joi.object(cleanupSchema) }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = Container.get(RetentionService);
        const data = await service.preview(req.body);
        res.send({ code: 200, data });
      } catch (error) {
        next(error);
      }
    },
  );

  route.post(
    '/cleanup',
    celebrate({
      body: Joi.object({
        ...cleanupSchema,
        confirmation: Joi.string().valid('CLEAN').required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = Container.get(RetentionService);
        const data = await service.cleanup(req.body);
        res.send({ code: 200, data });
      } catch (error) {
        next(error);
      }
    },
  );
};
