import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import * as fs from 'fs';
import config from '../config';
import SystemService from '../services/system';
import { celebrate, Joi } from 'celebrate';
import UserService from '../services/user';
import { EnvModel } from '../data/env';
import {
  getUniqPath,
  handleLogPath,
  parseVersion,
  promiseExec,
} from '../config/util';
import dayjs from 'dayjs';

const route = Router();

export default (app: Router) => {
  app.use('/system', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const userService = Container.get(UserService);
      const authInfo = await userService.getUserInfo();
      const envCount = await EnvModel.count();
      const { version, changeLog, changeLogLink } = await parseVersion(
        config.versionFile,
      );
      const lastCommitTime = (
        await promiseExec(
          `cd ${config.rootPath} && git show -s --format=%ai | head -1`,
        )
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
        authInfo.password === 'admin'
      ) {
        isInitialized = false;
      }
      res.send({
        code: 200,
        data: {
          isInitialized,
          version,
          lastCommitTime: dayjs(lastCommitTime).unix(),
          lastCommitId,
          branch,
          changeLog,
          changeLogLink,
        },
      });
    } catch (e) {
      logger.error('🔥 error: %o', e);
      return next(e);
    }
  });

  route.get(
    '/config',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const systemService = Container.get(SystemService);
        const data = await systemService.getSystemConfig();
        res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/config',
    celebrate({
      body: Joi.object({
        logRemoveFrequency: Joi.number().optional().allow(null),
        cronConcurrency: Joi.number().optional().allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.updateSystemConfig(
          req.body,
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

  route.put(
    '/command-run',
    celebrate({
      body: Joi.object({
        command: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const uniqPath = await getUniqPath(req.body.command);
        const logTime = dayjs().format('YYYY-MM-DD-HH-mm-ss-SSS');
        const logPath = `${uniqPath}/${logTime}.log`;
        res.setHeader('Content-type', 'application/octet-stream');
        await systemService.run(
          { ...req.body, logPath },
          {
            onStart: async (cp, startTime) => {
              res.setHeader('QL-Task-Pid', `${cp.pid}`);
            },
            onEnd: async (cp, endTime, diff) => {
              res.end();
            },
            onError: async (message: string) => {
              res.write(`\n${message}`);
              const absolutePath = await handleLogPath(logPath);
              fs.appendFileSync(absolutePath, `\n${message}`);
            },
            onLog: async (message: string) => {
              res.write(`\n${message}`);
              const absolutePath = await handleLogPath(logPath);
              fs.appendFileSync(absolutePath, `\n${message}`);
            },
          },
        );
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/command-stop',
    celebrate({
      body: Joi.object({
        command: Joi.string().optional(),
        pid: Joi.number().optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.stop(req.body);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );
};
