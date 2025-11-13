# 非root用户运行 Docker 指南 / Non-Root Docker User Guide

[English](#english) | [简体中文](#简体中文)

---

## 简体中文

### 问题背景

青龙面板依赖系统的 `cron` 服务来执行定时任务。在 Docker 容器中运行时，不同的基础镜像对 `cron` 的权限要求不同：

- **Alpine Linux**: 使用 BusyBox 的 `crond` 实现，**要求 root 权限**才能运行
- **Debian/Ubuntu**: 使用标准的 `cron` 实现，**支持非 root 用户**运行自己的 crontab

### 推荐方案：使用 Debian 镜像

如果您的环境**不能使用 root 用户运行 Docker**，我们强烈推荐使用 Debian 版本的镜像：

```bash
docker pull whyour/qinglong:debian
```

### 为什么 Debian 镜像适合非 root 用户？

1. **用户级 crontab 支持**: Debian 的 `cron` 服务支持每个用户维护自己的 crontab，无需 root 权限
2. **兼容性更好**: 支持更多需要标准 GNU 工具链的依赖包
3. **权限管理更灵活**: 可以轻松配置文件和进程的权限

### 使用 Debian 镜像运行（非 root 用户）

#### 方式一：使用 docker run

```bash
# 创建数据目录并设置权限
mkdir -p /your/data/path
chown -R 1000:1000 /your/data/path  # 1000 是容器内默认用户 ID

# 以非 root 用户运行
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -v /your/data/path:/ql/data \
  -p 5700:5700 \
  whyour/qinglong:debian
```

#### 方式二：使用 docker-compose

```yaml
version: '3'
services:
  qinglong:
    image: whyour/qinglong:debian
    container_name: qinglong
    user: "1000:1000"  # 指定用户 ID 和组 ID
    volumes:
      - ./data:/ql/data
    ports:
      - "5700:5700"
    restart: unless-stopped
```

### Alpine 镜像的限制

如果您必须使用 Alpine 镜像（`whyour/qinglong:latest`），需要注意：

1. **必须以 root 用户运行**: Alpine 的 `crond` 需要 root 权限
2. **不支持非 root 模式**: 尝试以非 root 用户运行会导致定时任务无法执行
3. **错误表现**: 
   - 可以添加定时任务（数据库操作成功）
   - 任务不会被定时执行（`crontab` 命令失败）
   - 可能看到 "Operation not permitted" 相关错误

### 故障排查

#### 如何确认当前使用的镜像版本？

```bash
docker inspect qinglong | grep Image
```

#### 如何测试 crontab 权限？

在容器内执行：

```bash
# 进入容器
docker exec -it qinglong bash

# 测试 crontab 命令
crontab -l

# 如果看到 "must be suid to work properly" 或权限错误，说明需要 root 权限
```

#### 如何迁移到 Debian 镜像？

```bash
# 1. 停止并备份当前容器的数据
docker stop qinglong
docker cp qinglong:/ql/data ./data_backup

# 2. 删除旧容器
docker rm qinglong

# 3. 使用 Debian 镜像创建新容器
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -v ./data_backup:/ql/data \
  -p 5700:5700 \
  whyour/qinglong:debian
```

### 技术细节：定时任务添加流程

当您在前端添加新的定时任务时，后端经历以下步骤：

1. **数据库操作** (`back/services/cron.ts:create()`)
   - 创建 `Crontab` 记录并保存到数据库
   - 这一步**不需要特殊权限**，通常能成功

2. **Node Cron 注册** (如果是 6 段或更多段的 cron 表达式)
   - 通过 `cronClient.addCron()` 注册到 Node.js 的 cron 调度器
   - 这一步也**不需要系统权限**

3. **系统 Crontab 更新** (`back/services/cron.ts:setCrontab()`, 第 672 行)
   - 执行 `crontab <config_file>` 命令
   - **这一步在 Alpine 上需要 root 权限**
   - 在 Debian 上非 root 用户可以成功执行

4. **Crond 守护进程** (`docker/docker-entrypoint.sh`, 第 36 行)
   - 运行 `crond -f` 守护进程来执行定时任务
   - **Alpine 的 crond 必须以 root 运行**
   - Debian 的 cron 支持用户级运行

### 相关资源

- [Alpine Linux crontab 权限问题](https://gitlab.alpinelinux.org/alpine/aports/-/issues/5380)
- [StackOverflow: Alpine 上 crontab 编辑失败](https://stackoverflow.com/questions/36453787/failed-to-edit-crontab-linux-alpine)
- [Debian cron 手册](https://manpages.debian.org/bullseye/cron/cron.8.en.html)

---

## English

### Background

Qinglong panel relies on the system's `cron` service to execute scheduled tasks. When running in Docker containers, different base images have different permission requirements for `cron`:

- **Alpine Linux**: Uses BusyBox's `crond` implementation, **requires root privileges**
- **Debian/Ubuntu**: Uses standard `cron` implementation, **supports non-root users**

### Recommended Solution: Use Debian Image

If your environment **cannot run Docker as root**, we strongly recommend using the Debian version:

```bash
docker pull whyour/qinglong:debian
```

### Why Debian Image is Better for Non-Root Users?

1. **User-level crontab support**: Debian's `cron` allows each user to maintain their own crontab without root privileges
2. **Better compatibility**: Supports more dependency packages that require standard GNU toolchain
3. **Flexible permission management**: Easy to configure file and process permissions

### Running with Debian Image (Non-Root User)

#### Method 1: Using docker run

```bash
# Create data directory and set permissions
mkdir -p /your/data/path
chown -R 1000:1000 /your/data/path  # 1000 is the default user ID in container

# Run as non-root user
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -v /your/data/path:/ql/data \
  -p 5700:5700 \
  whyour/qinglong:debian
```

#### Method 2: Using docker-compose

```yaml
version: '3'
services:
  qinglong:
    image: whyour/qinglong:debian
    container_name: qinglong
    user: "1000:1000"  # Specify user ID and group ID
    volumes:
      - ./data:/ql/data
    ports:
      - "5700:5700"
    restart: unless-stopped
```

### Alpine Image Limitations

If you must use the Alpine image (`whyour/qinglong:latest`), please note:

1. **Must run as root**: Alpine's `crond` requires root privileges
2. **No non-root support**: Attempting to run as non-root will cause scheduled tasks to fail
3. **Error symptoms**:
   - Can add scheduled tasks (database operation succeeds)
   - Tasks won't execute on schedule (`crontab` command fails)
   - May see "Operation not permitted" related errors

### Troubleshooting

#### How to check current image version?

```bash
docker inspect qinglong | grep Image
```

#### How to test crontab permissions?

Execute inside the container:

```bash
# Enter container
docker exec -it qinglong bash

# Test crontab command
crontab -l

# If you see "must be suid to work properly" or permission errors, root is required
```

#### How to migrate to Debian image?

```bash
# 1. Stop and backup current container data
docker stop qinglong
docker cp qinglong:/ql/data ./data_backup

# 2. Remove old container
docker rm qinglong

# 3. Create new container with Debian image
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -v ./data_backup:/ql/data \
  -p 5700:5700 \
  whyour/qinglong:debian
```

### Technical Details: Scheduled Task Addition Flow

When you add a new scheduled task from the frontend, the backend goes through these steps:

1. **Database Operation** (`back/services/cron.ts:create()`)
   - Creates `Crontab` record and saves to database
   - **Doesn't require special permissions**, usually succeeds

2. **Node Cron Registration** (if cron expression has 6+ segments)
   - Registers with Node.js cron scheduler via `cronClient.addCron()`
   - **Doesn't require system permissions**

3. **System Crontab Update** (`back/services/cron.ts:setCrontab()`, line 672)
   - Executes `crontab <config_file>` command
   - **Requires root privileges on Alpine**
   - Non-root users can execute successfully on Debian

4. **Crond Daemon** (`docker/docker-entrypoint.sh`, line 36)
   - Runs `crond -f` daemon to execute scheduled tasks
   - **Alpine's crond must run as root**
   - Debian's cron supports user-level execution

### Related Resources

- [Alpine Linux crontab permission issue](https://gitlab.alpinelinux.org/alpine/aports/-/issues/5380)
- [StackOverflow: Failed to edit crontab on Alpine](https://stackoverflow.com/questions/36453787/failed-to-edit-crontab-linux-alpine)
- [Debian cron manual](https://manpages.debian.org/bullseye/cron/cron.8.en.html)
