import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import * as fs from 'fs';
import config from '../config';
import SystemService from '../services/system';
import { celebrate, Joi } from 'celebrate';
import UserService from '../services/user';
import { EnvModel } from '../data/env';
import { promiseExec } from '../config/util';

const route = Router();

export default (app: Router) => {
  app.use('/system', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const userService = Container.get(UserService);
      const authInfo = await userService.getUserInfo();
      const envCount = await EnvModel.count();
      const versionRegx = /.*export const version = \'(.*)\'\;/;

      const currentVersionFile = fs.readFileSync(config.versionFile, 'utf8');
      const version = currentVersionFile.match(versionRegx)![1];
      const lastCommitTime = (
        await promiseExec(`cd ${config.rootPath} && git show -s --format=%ai`)
      ).replace('\n', '');
      const lastCommitId = (
        await promiseExec(`cd ${config.rootPath} && git rev-parse --short HEAD`)
      ).replace('\n', '');
      const branch = (
        await promiseExec(
          `cd ${config.rootPath} && git symbolic-ref --short HEAD`,
        )
      ).replace('\n', '');

      let isInitialized = true;
      if (
        Object.keys(authInfo).length === 2 &&
        authInfo.username === 'admin' &&
        authInfo.password === 'admin' &&
        envCount === 0
      ) {
        isInitialized = false;
      }
      res.send({
        code: 200,
        data: {
          isInitialized,
          version,
          lastCommitTime,
          lastCommitId,
          branch,
        },
      });
    } catch (e) {
      logger.error('🔥 error: %o', e);
      return next(e);
    }
  });

  route.get(
    '/log/remove',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const systemService = Container.get(SystemService);
        const data = await systemService.getLogRemoveFrequency();
        res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/log/remove',
    celebrate({
      body: Joi.object({
        frequency: Joi.number().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.updateLogRemoveFrequency(
          req.body.frequency,
        );
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/update-check',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.checkUpdate();
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/update',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.updateSystem();
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/notify',
    celebrate({
      body: Joi.object({
        title: Joi.string().required(),
        content: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.notify(req.body);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );
};
