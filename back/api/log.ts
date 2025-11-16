import { celebrate, Joi } from 'celebrate';
import { NextFunction, Request, Response, Router } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import {
  getFileContentByName,
  readDirs,
  removeAnsi,
  rmPath,
  IFile,
} from '../config/util';
import LogService from '../services/log';
import CronService from '../services/cron';
import { UserRole } from '../data/user';
import { Crontab } from '../data/cron';
const route = Router();
const blacklist = ['.tmp'];

export default (app: Router) => {
  app.use('/logs', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const result = await readDirs(config.logPath, config.logPath, blacklist);
      
      // Filter logs based on user permissions
      if (req.user?.role !== UserRole.admin && req.user?.userId) {
        const cronService = Container.get(CronService);
        const { data: userCrons } = await cronService.crontabs({
          searchValue: '',
          page: '0',
          size: '0',
          sorter: '',
          filters: '',
          queryString: '',
          userId: req.user.userId,
        });
        
        // Build a set of log paths that the user has access to
        const allowedLogPaths = new Set(
          userCrons
            .filter((cron: Crontab) => cron.log_name && cron.log_name !== '/dev/null')
            .map((cron: Crontab) => cron.log_name)
        );
        
        // Filter the result to only include logs the user owns
        const filteredResult = (result as IFile[]).filter((item: IFile) =>
          item.type === 'directory' && (allowedLogPaths.has(item.title) || allowedLogPaths.has(`${item.title}/`))
        );
        
        res.send({
          code: 200,
          data: filteredResult,
        });
        return;
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
    '/detail',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const logService = Container.get(LogService);
        const finalPath = logService.checkFilePath(
          (req.query.path as string) || '',
          (req.query.file as string) || '',
        );
        if (!finalPath || blacklist.includes(req.query.path as string)) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        
        // Check if user has permission to view this log
        if (req.user?.role !== UserRole.admin && req.user?.userId) {
          const cronService = Container.get(CronService);
          const { data: userCrons } = await cronService.crontabs({
            searchValue: '',
            page: '0',
            size: '0',
            sorter: '',
            filters: '',
            queryString: '',
            userId: req.user.userId,
          });
          
          const logPath = (req.query.path as string) || '';
          const hasAccess = userCrons.some((cron: Crontab) => 
            cron.log_name && 
            cron.log_name !== '/dev/null' && 
            (logPath.startsWith(cron.log_name) || cron.log_name.startsWith(logPath))
          );
          
          if (!hasAccess) {
            return res.send({
              code: 403,
              message: '暂无权限',
            });
          }
        }
        
        const content = await getFileContentByName(finalPath);
        res.send({ code: 200, data: removeAnsi(content) });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const logService = Container.get(LogService);
        const finalPath = logService.checkFilePath(
          (req.query.path as string) || '',
          (req.params.file as string) || '',
        );
        if (!finalPath || blacklist.includes(req.query.path as string)) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        
        // Check if user has permission to view this log
        if (req.user?.role !== UserRole.admin && req.user?.userId) {
          const cronService = Container.get(CronService);
          const { data: userCrons } = await cronService.crontabs({
            searchValue: '',
            page: '0',
            size: '0',
            sorter: '',
            filters: '',
            queryString: '',
            userId: req.user.userId,
          });
          
          const logPath = (req.query.path as string) || '';
          const hasAccess = userCrons.some((cron: Crontab) => 
            cron.log_name && 
            cron.log_name !== '/dev/null' && 
            (logPath.startsWith(cron.log_name) || cron.log_name.startsWith(logPath))
          );
          
          if (!hasAccess) {
            return res.send({
              code: 403,
              message: '暂无权限',
            });
          }
        }
        
        const content = await getFileContentByName(finalPath);
        res.send({ code: 200, data: content });
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
        type: Joi.string().optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        const logService = Container.get(LogService);
        const finalPath = logService.checkFilePath(path, filename);
        if (!finalPath || blacklist.includes(path)) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        
        // Check if user has permission to delete this log
        if (req.user?.role !== UserRole.admin && req.user?.userId) {
          const cronService = Container.get(CronService);
          const { data: userCrons } = await cronService.crontabs({
            searchValue: '',
            page: '0',
            size: '0',
            sorter: '',
            filters: '',
            queryString: '',
            userId: req.user.userId,
          });
          
          const hasAccess = userCrons.some((cron: Crontab) => 
            cron.log_name && 
            cron.log_name !== '/dev/null' && 
            (path.startsWith(cron.log_name) || cron.log_name.startsWith(path))
          );
          
          if (!hasAccess) {
            return res.send({
              code: 403,
              message: '暂无权限',
            });
          }
        }
        
        await rmPath(finalPath);
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
        path: Joi.string().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        const logService = Container.get(LogService);
        const filePath = logService.checkFilePath(path, filename);
        if (!filePath) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        
        // Check if user has permission to download this log
        if (req.user?.role !== UserRole.admin && req.user?.userId) {
          const cronService = Container.get(CronService);
          const { data: userCrons } = await cronService.crontabs({
            searchValue: '',
            page: '0',
            size: '0',
            sorter: '',
            filters: '',
            queryString: '',
            userId: req.user.userId,
          });
          
          const hasAccess = userCrons.some((cron: Crontab) => 
            cron.log_name && 
            cron.log_name !== '/dev/null' && 
            (path.startsWith(cron.log_name) || cron.log_name.startsWith(path))
          );
          
          if (!hasAccess) {
            return res.send({
              code: 403,
              message: '暂无权限',
            });
          }
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
};
