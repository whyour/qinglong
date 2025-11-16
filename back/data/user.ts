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

  constructor(options: User) {
    this.id = options.id;
    this.username = options.username;
    this.password = options.password;
    this.role = options.role || UserRole.user;
    this.status =
      typeof options.status === 'number' && UserStatus[options.status]
        ? options.status
        : UserStatus.active;
    this.createdAt = options.createdAt;
    this.updatedAt = options.updatedAt;
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
    type: DataTypes.NUMBER,
    defaultValue: UserRole.user,
  },
  status: {
    type: DataTypes.NUMBER,
    defaultValue: UserStatus.active,
  },
});
