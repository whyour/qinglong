# 多用户管理功能说明 (Multi-User Management Guide)

## 功能概述 (Overview)

青龙面板现已支持多用户管理和数据隔离功能。管理员可以创建多个用户账号，每个用户只能看到和操作自己的数据。

Qinglong now supports multi-user management with data isolation. Administrators can create multiple user accounts, and each user can only see and operate their own data.

## 用户角色 (User Roles)

### 管理员 (Admin)
- 可以访问所有用户的数据
- 可以创建、编辑、删除用户
- 可以管理系统设置
- Can access all users' data
- Can create, edit, and delete users
- Can manage system settings

### 普通用户 (Regular User)
- 只能访问自己创建的数据
- 可以管理自己的定时任务、环境变量、订阅和依赖
- 无法访问其他用户的数据
- Can only access their own data
- Can manage their own cron jobs, environment variables, subscriptions, and dependencies
- Cannot access other users' data

## API 使用 (API Usage)

### 用户管理接口 (User Management Endpoints)

所有用户管理接口需要管理员权限。
All user management endpoints require admin privileges.

#### 获取用户列表 (Get User List)
```
GET /api/user-management?searchValue=keyword
```

#### 创建用户 (Create User)
```
POST /api/user-management
{
  "username": "user1",
  "password": "password123",
  "role": 1,  // 0: admin, 1: user
  "status": 0  // 0: active, 1: disabled
}
```

#### 更新用户 (Update User)
```
PUT /api/user-management
{
  "id": 1,
  "username": "user1",
  "password": "newpassword",
  "role": 1,
  "status": 0
}
```

#### 删除用户 (Delete Users)
```
DELETE /api/user-management
[1, 2, 3]  // User IDs to delete
```

## 数据隔离 (Data Isolation)

### 定时任务 (Cron Jobs)
- 每个用户创建的定时任务会自动关联到该用户
- 用户只能查看、编辑、运行、删除自己的定时任务
- 管理员可以查看所有用户的定时任务

### 环境变量 (Environment Variables)
- 每个用户的环境变量相互隔离
- 用户只能查看和修改自己的环境变量
- 管理员可以查看所有环境变量

### 订阅和依赖 (Subscriptions and Dependencies)
- 用户数据完全隔离
- Only accessible by the owning user and admins

## 密码安全 (Password Security)

- 所有密码使用 bcrypt 加密存储
- 密码长度最少为 6 位
- 建议使用强密码
- All passwords are hashed with bcrypt
- Minimum password length is 6 characters
- Strong passwords are recommended

## 数据迁移 (Data Migration)

### 迁移工具 (Migration Tool)

项目提供了数据迁移脚本，可以将现有数据分配给特定用户。

A migration script is provided to assign existing data to specific users.

#### 使用方法 (Usage)

1. **列出所有用户 (List all users)**
```bash
node migrate-to-multiuser.js --list-users
```

2. **预览迁移（不实际执行）(Dry run)**
```bash
node migrate-to-multiuser.js --userId=1 --dry-run
```

3. **将数据迁移到指定用户ID (Migrate to user ID)**
```bash
node migrate-to-multiuser.js --userId=1
```

4. **将数据迁移到指定用户名 (Migrate to username)**
```bash
node migrate-to-multiuser.js --username=admin
```

#### 注意事项 (Important Notes)

- 迁移脚本只会处理 `userId` 为空的数据（遗留数据）
- 已分配给用户的数据不会被修改
- 建议先使用 `--dry-run` 预览变更
- 迁移过程中如果出错会自动回滚

- The script only migrates data where `userId` is NULL (legacy data)
- Data already assigned to users will not be changed
- It's recommended to use `--dry-run` first to preview changes
- Changes are automatically rolled back if an error occurs

## 向后兼容 (Backward Compatibility)

- 原有的单用户系统管理员账号继续有效
- 已存在的数据可以被所有用户访问（遗留数据）
- 新创建的数据会自动关联到创建者
- The original system admin account remains valid
- Existing data is accessible by all users (legacy data)
- Newly created data is automatically associated with the creator

## 注意事项 (Notes)

1. **首次使用**：首次使用多用户功能时，建议先创建一个管理员账号作为备份
2. **密码管理**：请妥善保管用户密码，忘记密码需要管理员重置
3. **数据迁移**：使用提供的 `migrate-to-multiuser.js` 脚本将现有数据分配给特定用户
4. **权限控制**：删除用户不会删除该用户的数据，数据会变为遗留数据

1. **First Use**: When first using multi-user functionality, it's recommended to create an admin account as a backup
2. **Password Management**: Please keep user passwords safe; forgotten passwords need admin reset
3. **Data Migration**: Use the provided `migrate-to-multiuser.js` script to assign existing data to specific users
4. **Permission Control**: Deleting a user doesn't delete their data; the data becomes legacy data
