import { Service, Inject } from 'typedi';
import winston from 'winston';
import { User, UserModel, UserStatus } from '../data/user';
import { Op } from 'sequelize';
import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config';
import {
  hashPassword,
  verifyPassword,
  isPasswordHash,
} from '../shared/password';
import { serializeAuthMutation } from '../shared/authMutation';
import { shareStore } from '../shared/store';

type PublicUser = Omit<User, 'password' | 'sessions'>;
function publicUser(user: User): PublicUser {
  const { password, sessions, ...result } = user;
  return result;
}
function digest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

@Service()
export default class UserManagementService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public async list(searchText?: string): Promise<PublicUser[]> {
    const where = searchText
      ? { username: { [Op.like]: `%${searchText}%` } }
      : {};
    return (await UserModel.findAll({ where })).map((x) =>
      publicUser(x.get({ plain: true })),
    );
  }
  public async get(id: number): Promise<PublicUser> {
    const doc = await UserModel.findByPk(id);
    if (!doc) throw Object.assign(new Error('用户不存在'), { status: 404 });
    return publicUser(doc.get({ plain: true }));
  }
  public async getByUsername(username: string): Promise<User | null> {
    return (
      (await UserModel.findOne({ where: { username } }))?.get({
        plain: true,
      }) || null
    );
  }
  @serializeAuthMutation
  public async create(payload: User): Promise<PublicUser> {
    const auth = await shareStore.getAuthInfo();
    if (
      auth?.username === payload.username ||
      (await this.getByUsername(payload.username))
    )
      throw Object.assign(new Error('用户名已存在'), { status: 400 });
    if (!payload.password || payload.password.length < 6)
      throw Object.assign(new Error('密码长度至少为6位'), { status: 400 });
    const user = new User({
      ...payload,
      password: await hashPassword(payload.password),
      sessions: [],
    });
    return publicUser((await UserModel.create(user)).get({ plain: true }));
  }
  @serializeAuthMutation
  public async update(
    payload: Partial<User> & { id: number },
  ): Promise<PublicUser> {
    const existing = await this.get(payload.id);
    if (payload.username && payload.username !== existing.username) {
      const auth = await shareStore.getAuthInfo();
      if (
        auth?.username === payload.username ||
        (await this.getByUsername(payload.username))
      )
        throw Object.assign(new Error('用户名已存在'), { status: 400 });
    }
    const changes: Partial<User> = {};
    for (const key of ['username', 'role', 'status'] as const)
      if (payload[key] !== undefined) (changes as any)[key] = payload[key];
    if (payload.password) {
      if (payload.password.length < 6)
        throw Object.assign(new Error('密码长度至少为6位'), { status: 400 });
      changes.password = await hashPassword(payload.password);
    }
    if (Object.keys(changes).length) changes.sessions = [];
    await UserModel.update(changes, { where: { id: payload.id } });
    return this.get(payload.id);
  }
  @serializeAuthMutation
  public async delete(ids: number[]): Promise<number> {
    return UserModel.destroy({ where: { id: ids } });
  }
  public async authenticate(
    username: string,
    password: string,
  ): Promise<User | null> {
    const user = await this.getByUsername(username);
    if (
      !user ||
      user.status !== UserStatus.active ||
      !isPasswordHash(user.password)
    )
      return null;
    return (await verifyPassword(password, user.password)) ? user : null;
  }
  // Caller holds the shared account mutation queue during authentication and issuance.
  public async issueToken(user: User, platform: string): Promise<string> {
    const token = jwt.sign(
      { userId: user.id, nonce: randomBytes(32).toString('hex') },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn || '20d', algorithm: 'HS384' },
    );
    const sessions = [
      ...(user.sessions || []).filter((x) => x.platform !== platform),
      { digest: digest(token), platform },
    ].slice(-10);
    await UserModel.update({ sessions }, { where: { id: user.id } });
    return token;
  }
  public async validateToken(
    token: string,
    platform: string,
  ): Promise<PublicUser | null> {
    try {
      const payload = jwt.verify(token, config.jwt.secret, {
        algorithms: ['HS384'],
      });
      if (
        typeof payload === 'string' ||
        !Number.isSafeInteger(payload.userId) ||
        payload.userId <= 0
      )
        return null;
      const user = (await UserModel.findByPk(payload.userId))?.get({
        plain: true,
      });
      if (
        !user ||
        user.status !== UserStatus.active ||
        !user.sessions?.some(
          (x) => x.digest === digest(token) && x.platform === platform,
        )
      )
        return null;
      return publicUser(user);
    } catch {
      return null;
    }
  }
  @serializeAuthMutation
  public async revokeToken(id: number, token: string): Promise<void> {
    const user = await UserModel.findByPk(id);
    if (!user) return;
    await user.update({
      sessions: (user.sessions || []).filter((x) => x.digest !== digest(token)),
    });
  }
}
