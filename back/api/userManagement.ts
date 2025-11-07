import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { celebrate, Joi } from 'celebrate';
import UserManagementService from '../services/userManagement';
import { UserRole } from '../data/user';

const route = Router();

// Middleware to check if user is admin
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.user && (req.user as any).role === UserRole.admin) {
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
        const data = await userManagementService.list(req.query.searchValue as string);
        res.send({ code: 200, data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // Get a specific user (admin only)
  route.get(
    '/:id',
    requireAdmin,
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
        username: Joi.string().required(),
        password: Joi.string().required(),
        role: Joi.number().valid(UserRole.admin, UserRole.user).default(UserRole.user),
        status: Joi.number().optional(),
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
        id: Joi.number().required(),
        username: Joi.string().required(),
        password: Joi.string().required(),
        role: Joi.number().valid(UserRole.admin, UserRole.user),
        status: Joi.number().optional(),
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
      body: Joi.array().items(Joi.number()).required(),
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
