import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { celebrate, Joi } from 'celebrate';
import UserManagementService from '../services/userManagement';
import { UserRole, UserStatus } from '../data/user';
import { EnvModel } from '../data/env';
import { CrontabModel } from '../data/cron';
import { SubscriptionModel } from '../data/subscription';

const route = Router();

// Middleware to check if user is admin
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.user && req.user.role === UserRole.admin) {
    return next();
  }
  return res.status(403).send({ code: 403, message: '需要管理员权限' });
};

export default (app: Router) => {
  app.use('/user-management', route);

  // List all users (admin only)
  route.get(
    '/',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userManagementService = Container.get(UserManagementService);
        const data = await userManagementService.list(
          req.query.searchValue as string,
        );
        res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/:id/resources',
    requireAdmin,
    celebrate({
      params: Joi.object({ id: Joi.number().integer().positive().required() }),
      body: Joi.object({
        resource: Joi.string()
          .valid('envs', 'crons', 'subscriptions')
          .required(),
        ids: Joi.array()
          .min(1)
          .max(200)
          .unique()
          .items(Joi.number().integer().positive())
          .required(),
      }),
    }),
    async (req, res, next) => {
      try {
        const id = Number(req.params.id);
        await Container.get(UserManagementService).get(id);
        const models: Record<string, any> = {
          envs: EnvModel,
          crons: CrontabModel,
          subscriptions: SubscriptionModel,
        };
        const [count] = await models[req.body.resource].update(
          { userId: id },
          { where: { id: req.body.ids } },
        );
        return res.json({ code: 200, data: { assigned: count } });
      } catch (error) {
        return next(error);
      }
    },
  );

  // Get a specific user (admin only)
  route.get(
    '/:id',
    requireAdmin,
    celebrate({ params: Joi.object({ id: Joi.number().integer().positive().required() }) }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userManagementService = Container.get(UserManagementService);
        const data = await userManagementService.get(Number(req.params.id));
        res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // Create a new user (admin only)
  route.post(
    '/',
    requireAdmin,
    celebrate({
      body: Joi.object({
        username: Joi.string().trim().max(255).required(),
        password: Joi.string().min(6).max(1024).required(),
        role: Joi.number()
          .valid(UserRole.admin, UserRole.user)
          .default(UserRole.user),
        status: Joi.number()
          .valid(UserStatus.active, UserStatus.disabled)
          .optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userManagementService = Container.get(UserManagementService);
        const data = await userManagementService.create(req.body);
        res.send({ code: 200, data, message: '创建用户成功' });
      } catch (e: any) {
        return res.send({ code: 400, message: e.message });
      }
    },
  );

  // Update a user (admin only)
  route.put(
    '/',
    requireAdmin,
    celebrate({
      body: Joi.object({
        id: Joi.number().integer().positive().required(),
        username: Joi.string().trim().max(255).required(),
        password: Joi.string().min(6).max(1024).optional().allow(''),
        role: Joi.number().valid(UserRole.admin, UserRole.user),
        status: Joi.number()
          .valid(UserStatus.active, UserStatus.disabled)
          .optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userManagementService = Container.get(UserManagementService);
        const data = await userManagementService.update(req.body);
        res.send({ code: 200, data, message: '更新用户成功' });
      } catch (e: any) {
        return res.send({ code: 400, message: e.message });
      }
    },
  );

  // Delete users (admin only)
  route.delete(
    '/',
    requireAdmin,
    celebrate({
      body: Joi.array()
        .min(1)
        .max(200)
        .unique()
        .items(Joi.number().integer().positive())
        .required(),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userManagementService = Container.get(UserManagementService);
        const count = await userManagementService.delete(req.body);
        res.send({ code: 200, data: count, message: '删除用户成功' });
      } catch (e) {
        return next(e);
      }
    },
  );
};
