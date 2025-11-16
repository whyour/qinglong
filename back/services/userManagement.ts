import { Service, Inject } from 'typedi';
import winston from 'winston';
import { User, UserModel, UserRole, UserStatus } from '../data/user';
import { Op } from 'sequelize';
import bcrypt from 'bcrypt';

@Service()
export default class UserManagementService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  private async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }

  private async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  public async list(searchText?: string): Promise<User[]> {
    let query: any = {};
    if (searchText) {
      query = {
        username: { [Op.like]: `%${searchText}%` },
      };
    }
    const docs = await UserModel.findAll({ where: query });
    return docs.map((x) => x.get({ plain: true }));
  }

  public async get(id: number): Promise<User> {
    const doc = await UserModel.findByPk(id);
    if (!doc) {
      throw new Error('用户不存在');
    }
    return doc.get({ plain: true });
  }

  public async getByUsername(username: string): Promise<User | null> {
    const doc = await UserModel.findOne({ where: { username } });
    if (!doc) {
      return null;
    }
    return doc.get({ plain: true });
  }

  public async create(payload: User): Promise<User> {
    const existingUser = await this.getByUsername(payload.username);
    if (existingUser) {
      throw new Error('用户名已存在');
    }
    
    if (payload.password.length < 6) {
      throw new Error('密码长度至少为6位');
    }

    // Hash the password before storing
    const hashedPassword = await this.hashPassword(payload.password);
    const userWithHashedPassword = { ...payload, password: hashedPassword };
    
    const doc = await UserModel.create(userWithHashedPassword);
    return doc.get({ plain: true });
  }

  public async update(payload: User): Promise<User> {
    if (!payload.id) {
      throw new Error('缺少用户ID');
    }

    const existingUser = await this.get(payload.id);
    if (!existingUser) {
      throw new Error('用户不存在');
    }

    if (payload.password && payload.password.length < 6) {
      throw new Error('密码长度至少为6位');
    }

    // Check if username is being changed and if new username already exists
    if (payload.username !== existingUser.username) {
      const userWithSameUsername = await this.getByUsername(payload.username);
      if (userWithSameUsername && userWithSameUsername.id !== payload.id) {
        throw new Error('用户名已存在');
      }
    }

    // Hash the password if it's being updated
    const updatePayload = { ...payload };
    if (payload.password) {
      updatePayload.password = await this.hashPassword(payload.password);
    }

    const [, [updated]] = await UserModel.update(updatePayload, {
      where: { id: payload.id },
      returning: true,
    });
    return updated.get({ plain: true });
  }

  public async delete(ids: number[]): Promise<number> {
    const count = await UserModel.destroy({ where: { id: ids } });
    return count;
  }

  public async authenticate(
    username: string,
    password: string,
  ): Promise<User | null> {
    const user = await this.getByUsername(username);
    if (!user) {
      return null;
    }

    const isPasswordValid = await this.verifyPassword(password, user.password);
    if (!isPasswordValid) {
      return null;
    }

    if (user.status === UserStatus.disabled) {
      throw new Error('用户已被禁用');
    }

    return user;
  }
}
