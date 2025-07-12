import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import * as fs from 'fs/promises';
import config from '../config';
import SystemService from '../services/system';
import { celebrate, Joi } from 'celebrate';
import UserService from '../services/user';
import {
  getUniqPath,
  handleLogPath,
  parseVersion,
  promiseExec,
} from '../config/util';
import dayjs from 'dayjs';
import multer from 'multer';

const route = Router();
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.tmpPath);
  },
  filename: function (req, file, cb) {
    cb(null, 'data.tgz');
  },
});
const upload = multer({ storage: storage });

export default (app: Router) => {
  app.use('/system', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const userService = Container.get(UserService);
      const authInfo = await userService.getAuthInfo();
      const { version, changeLog, changeLogLink, publishTime } =
        await parseVersion(config.versionFile);

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
          publishTime: dayjs(publishTime).unix(),
          branch: process.env.QL_BRANCH || 'master',
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
    '/config/log-remove-frequency',
    celebrate({
      body: Joi.object({
        logRemoveFrequency: Joi.number().allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.updateLogRemoveFrequency(req.body);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/config/cron-concurrency',
    celebrate({
      body: Joi.object({
        cronConcurrency: Joi.number().allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.updateCronConcurrency(req.body);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/config/dependence-proxy',
    celebrate({
      body: Joi.object({
        dependenceProxy: Joi.string().allow('').allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.updateDependenceProxy(req.body);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/config/node-mirror',
    celebrate({
      body: Joi.object({
        nodeMirror: Joi.string().allow('').allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        res.setHeader('Content-type', 'application/octet-stream');
        await systemService.updateNodeMirror(req.body, res);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/config/python-mirror',
    celebrate({
      body: Joi.object({
        pythonMirror: Joi.string().allow('').allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.updatePythonMirror(req.body);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/config/linux-mirror',
    celebrate({
      body: Joi.object({
        linuxMirror: Joi.string().allow('').allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        res.setHeader('Content-type', 'application/octet-stream');
        await systemService.updateLinuxMirror(req.body, res);
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
    '/reload',
    celebrate({
      body: Joi.object({
        type: Joi.string().optional().allow('').allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.reloadSystem(req.body.type);
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
        const command = req.body.command;
        const idStr = `cat ${config.crontabFile} | grep -E "${command}" | perl -pe "s|.*ID=(.*) ${command}.*|\\1|" | head -1 | awk -F " " '{print $1}' | xargs echo -n`;
        let id = await promiseExec(idStr);
        const uniqPath = await getUniqPath(command, id);
        const logTime = dayjs().format('YYYY-MM-DD-HH-mm-ss-SSS');
        const logPath = `${uniqPath}/${logTime}.log`;
        res.setHeader('Content-type', 'application/octet-stream');
        await systemService.run(
          { ...req.body, logPath },
          {
            onStart: async (cp, startTime) => {
              res.setHeader('QL-Task-Pid', `${cp.pid}`);
              res.setHeader('QL-Task-Log', `${logPath}`);
            },
            onEnd: async (cp, endTime, diff) => {
              res.end();
            },
            onError: async (message: string) => {
              res.write(message);
              const absolutePath = await handleLogPath(logPath);
              await fs.appendFile(absolutePath, message);
            },
            onLog: async (message: string) => {
              res.write(message);
              const absolutePath = await handleLogPath(logPath);
              await fs.appendFile(absolutePath, message);
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

  route.put(
    '/data/export',
    celebrate({
      body: Joi.object({
        type: Joi.array().items(Joi.string()).optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        await systemService.exportData(res, req.body.type);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/data/import',
    upload.single('data'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.importData();
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/log',
    celebrate({
      query: {
        startTime: Joi.string().allow('').optional(),
        endTime: Joi.string().allow('').optional(),
        t: Joi.string().optional(),
      },
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        await systemService.getSystemLog(
          res,
          req.query as {
            startTime?: string;
            endTime?: string;
          },
        );
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/log',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        await systemService.deleteSystemLog();
        res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/auth/reset',
    celebrate({
      body: Joi.object({
        retries: Joi.number().optional(),
        twoFactorActivated: Joi.boolean().optional(),
        password: Joi.string().optional(),
        username: Joi.string().optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userService = Container.get(UserService);
        await userService.resetAuthInfo(req.body);
        res.send({ code: 200, message: '更新成功' });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/config/timezone',
    celebrate({
      body: Joi.object({
        timezone: Joi.string().allow('').allow(null),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.updateTimezone(req.body);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/config/dependence-clean',
    celebrate({
      body: Joi.object({
        type: Joi.string().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const systemService = Container.get(SystemService);
        const result = await systemService.cleanDependence(req.body.type);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );
};
