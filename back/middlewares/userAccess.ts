import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { EnvModel } from '../data/env';
import { CrontabModel } from '../data/cron';
import { SubscriptionModel } from '../data/subscription';

// Ordinary users are read-only until task workers and shared files are isolated.
export async function userAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user || req.user.role === 0) return next();
  const userId = req.user.userId;
  if (!Number.isSafeInteger(userId) || userId! <= 0)
    return res.status(403).json({ code: 403, message: '需要有效用户会话' });
  const pathname = req.path.replace(/\/$/, '') || '/';
  if (
    (req.method === 'GET' &&
      ['/user', '/system', '/health'].includes(pathname)) ||
    (req.method === 'POST' && pathname === '/user/logout')
  )
    return next();
  if (req.method === 'GET' && pathname === '/crons/views')
    return res.json({ code: 200, data: [] });
  const match = pathname.match(
    /^\/(envs|crons|subscriptions)(?:\/([1-9][0-9]*))?$/,
  );
  if (req.method !== 'GET' || !match)
    return res
      .status(403)
      .json({
        code: 403,
        message: '普通用户只读自己的数据，执行和系统修改由管理员负责',
      });
  try {
    const models: Record<string, any> = {
      envs: EnvModel,
      crons: CrontabModel,
      subscriptions: SubscriptionModel,
    };
    const model = models[match[1]];
    const where: any = { userId };
    if (match[2]) {
      const id = Number(match[2]);
      if (!Number.isSafeInteger(id))
        return res.status(400).json({ code: 400, message: '无效 ID' });
      where.id = id;
      const doc = await model.findOne({ where });
      return doc
        ? res.json({ code: 200, data: doc.get({ plain: true }) })
        : res.status(404).json({ code: 404, message: '数据不存在' });
    }
    const search =
      typeof req.query.searchValue === 'string'
        ? req.query.searchValue.slice(0, 1024)
        : '';
    if (search) where.name = { [Op.like]: `%${search}%` };
    const docs = await model.findAll({ where, order: [['createdAt', 'DESC']] });
    const data = docs.map((doc: any) => doc.get({ plain: true }));
    return res.json({
      code: 200,
      data: match[1] === 'crons' ? { data, total: data.length } : data,
    });
  } catch (error) {
    return next(error);
  }
}
