import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import { celebrate, Joi } from 'celebrate';
import { join } from 'path';
import { SAMPLE_FILES } from '../config/const';
import ConfigService from '../services/config';
import { writeFileWithLock } from '../shared/utils';
const route = Router();

export default (app: Router) => {
  app.use('/configs', route);

  route.get(
    '/sample',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.send({
          code: 200,
          data: SAMPLE_FILES,
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/files',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const fileList = await fs.readdir(config.configPath, 'utf-8');
        res.send({
          code: 200,
          data: fileList
            .filter((x) => !config.blackFileList.includes(x))
            .map((x) => {
              return { title: x, value: x };
            }),
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/detail',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const configService = Container.get(ConfigService);
        await configService.getFile(req.query.path as string, res);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/save',
    celebrate({
      body: Joi.object({
        name: Joi.string().required(),
        content: Joi.string().allow('').optional().custom((value, helpers) => {
          if (!value) return value;

          // Security validation for configuration file content
          const dangerousPatterns = [
            // Command substitution that could download/execute malware
            { pattern: /\$\([^)]*curl[^)]*\)/gi, desc: '命令替换中的下载操作' },
            { pattern: /\$\([^)]*wget[^)]*\)/gi, desc: '命令替换中的下载操作' },
            { pattern: /`[^`]*curl[^`]*`/gi, desc: '反引号命令替换中的下载操作' },
            { pattern: /`[^`]*wget[^`]*`/gi, desc: '反引号命令替换中的下载操作' },
            
            // Suspicious file downloads followed by execution
            { pattern: /(curl|wget)[^;]*\|\s*bash/gi, desc: '下载并直接执行的危险模式' },
            { pattern: /(curl|wget)[^;]*&&\s*chmod\s*\+x/gi, desc: '下载并赋予执行权限的可疑模式' },
            
            // External URLs downloading executables with suspicious names
            { pattern: /https?:\/\/[^\s]+\/(fullgc|\.[\w-]+)[\s;"']/gi, desc: '可疑的外部可执行文件下载' },
            
            // Background execution of hidden files
            { pattern: /nohup\s+["']?[^"'\s]*\/\.\w+["']?\s*>/gi, desc: '后台执行隐藏文件' },
          ];

          for (const { pattern, desc } of dangerousPatterns) {
            if (pattern.test(value)) {
              return helpers.error('string.unsafe', { description: desc });
            }
          }

          // Check for excessive length
          if (value.length > 1000000) {
            return helpers.error('string.max', { limit: 1000000 });
          }

          return value;
        }).messages({
          'string.unsafe': '配置文件内容包含潜在危险的模式 ({#description})，已被安全系统拦截',
          'string.max': '配置文件内容过长，已被安全系统拦截',
        }),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const { name, content } = req.body;
        if (config.blackFileList.includes(name)) {
          res.send({ code: 403, message: '文件无法访问' });
          return;
        }
        let path = join(config.configPath, name);
        if (name.startsWith('data/scripts/')) {
          path = join(config.rootPath, name);
        }
        
        // Log security-relevant file modifications
        logger.info(`配置文件写入: ${name}, 大小: ${content?.length || 0} 字节`);
        
        await writeFileWithLock(path, content);
        res.send({ code: 200, message: '保存成功' });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const configService = Container.get(ConfigService);
        await configService.getFile(req.params.file, res);
      } catch (e) {
        return next(e);
      }
    },
  );
};
