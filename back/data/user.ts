import { sequelize } from '.';
import { DataTypes, Model } from 'sequelize';

export class User {
  id?: number;
  username: string;
  password: string;
  role: UserRole;
  status: UserStatus;
  createdAt?: Date;
  updatedAt?: Date;
  sessions?: { digest: string; platform: string }[];

  constructor(options: User) {
    this.id = options.id;
    this.username = options.username;
    this.password = options.password;
    this.role = options.role ?? UserRole.user;
    this.status =
      typeof options.status === 'number' && UserStatus[options.status]
        ? options.status
        : UserStatus.active;
    this.createdAt = options.createdAt;
    this.updatedAt = options.updatedAt;
    this.sessions = options.sessions || [];
  }
}

export enum UserRole {
  'admin' = 0,
  'user' = 1,
}

export enum UserStatus {
  'active' = 0,
  'disabled' = 1,
}

export interface UserInstance extends Model<User, User>, User {}
export const UserModel = sequelize.define<UserInstance>('User', {
  sessions: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
  username: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  role: {
    type: DataTypes.INTEGER,
    defaultValue: UserRole.user,
  },
  status: {
    type: DataTypes.INTEGER,
    defaultValue: UserStatus.active,
  },
});
