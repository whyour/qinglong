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

⚠️ **重要提示**: 当前 Debian 镜像默认以 root 用户运行。如果需要以非 root 用户运行，需要设置 `PM2_HOME` 环境变量以避免 PM2 权限错误。

**注意**: PM2_HOME 必须设置在容器本地文件系统（如 `/tmp`），不能在挂载的卷上，因为 PM2 的 Unix socket 在某些文件系统上不受支持。

#### 方式一：使用 docker run

```bash
# 创建数据目录并设置权限
mkdir -p /your/data/path
chown -R 1000:1000 /your/data/path  # 1000 是容器内默认用户 ID

# 以非 root 用户运行（需要设置 PM2_HOME）
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -e PM2_HOME=/tmp/.pm2 \
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
    environment:
      - PM2_HOME=/tmp/.pm2  # 必需：设置 PM2 工作目录到本地文件系统
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

### 非 root 用户运行的已知限制

使用 Debian 镜像以非 root 用户运行时，有以下已知限制：

1. **无法创建全局命令快捷方式**: 应用会尝试在 `/usr/local/bin/` 创建 `ql` 和 `task` 命令的符号链接，但非 root 用户无权限。**这不影响任何功能**，应用会自动使用完整路径，定时任务和所有功能正常工作。
2. **需要正确配置 PM2_HOME**: 必须设置为容器本地文件系统（如 `/tmp/.pm2`），详见上面的配置示例。

### 故障排查

#### 如何确认当前使用的镜像版本？

```bash
docker inspect qinglong | grep Image
```

#### PM2 权限错误（EACCES: permission denied）

如果看到类似以下错误：
```
Error: EACCES: permission denied, mkdir '/.pm2/logs'
Error: EACCES: permission denied, mkdir '/.pm2/pids'
```

**原因**: PM2 默认使用 `~/.pm2` 作为工作目录，非 root 用户可能没有权限。

**解决方案**: 设置 `PM2_HOME` 环境变量到容器本地文件系统的可写目录：

```bash
# 使用 docker run
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -e PM2_HOME=/tmp/.pm2 \
  -v /your/data/path:/ql/data \
  -p 5700:5700 \
  whyour/qinglong:debian

# 或在 docker-compose.yml 中添加
environment:
  - PM2_HOME=/tmp/.pm2
```

#### Symlink 权限错误（/usr/local/bin）

如果看到以下错误：
```
EACCES: permission denied, symlink '/ql/shell/update.sh' -> '/usr/local/bin/ql_tmp'
```

**原因**: 应用尝试在 `/usr/local/bin/` 创建 `ql` 和 `task` 命令的符号链接，非 root 用户无权限在系统目录创建。

**影响**: 这是一个警告，**不影响任何功能**。应用会自动检测符号链接是否可用，并在不可用时使用完整路径。

**定时任务自动适配**:
- ✅ 定时任务自动使用完整路径（如 `/ql/shell/task.sh`）
- ✅ Web 界面完全正常工作
- ✅ 所有核心功能不受影响
- ℹ️ 手动在命令行使用时需要完整路径

**解决方案**:
1. **忽略此错误**（推荐）- 应用已自动处理，功能完全正常
2. **如果需要在命令行使用 `ql` 和 `task` 命令**（非 root 用户）：

   **方式一：使用 Shell 别名**（推荐）
   ```bash
   # 在容器内执行
   docker exec -it qinglong bash
   
   # 添加别名到 ~/.bashrc
   echo 'alias ql="/ql/shell/update.sh"' >> ~/.bashrc
   echo 'alias task="/ql/shell/task.sh"' >> ~/.bashrc
   source ~/.bashrc
   
   # 现在可以直接使用命令
   ql update
   task script.js
   ```

   **方式二：添加到用户 PATH**
   ```bash
   # 在容器内执行
   docker exec -it qinglong bash
   
   # 创建用户 bin 目录
   mkdir -p ~/bin
   
   # 创建符号链接
   ln -sf /ql/shell/update.sh ~/bin/ql
   ln -sf /ql/shell/task.sh ~/bin/task
   
   # 添加到 PATH
   echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
   source ~/.bashrc
   
   # 现在可以直接使用命令
   ql update
   task script.js
   ```

   **方式三：使用完整路径**
   ```bash
   /ql/shell/update.sh  # 代替 ql update
   /ql/shell/task.sh    # 代替 task
   ```

#### PM2 Socket 错误（ENOTSUP）

如果看到以下错误：
```
Error: connect ENOTSUP /ql/data/.pm2/rpc.sock
```

**原因**: PM2 使用 Unix domain sockets 进行进程间通信，某些文件系统（如网络挂载、Windows 卷、某些 NFS）不支持 Unix sockets。

**解决方案**: 将 `PM2_HOME` 设置到容器的本地文件系统（如 `/tmp`），而不是挂载的卷：

```bash
# 正确：使用容器本地文件系统
-e PM2_HOME=/tmp/.pm2

# 错误：使用挂载的卷（可能不支持 Unix sockets）
-e PM2_HOME=/ql/data/.pm2
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

# 3. 使用 Debian 镜像创建新容器（设置 PM2_HOME）
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -e PM2_HOME=/tmp/.pm2 \
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

⚠️ **Important**: The current Debian image runs as root by default. If you need to run as a non-root user, you must set the `PM2_HOME` environment variable to avoid PM2 permission errors.

**Note**: PM2_HOME must be set on the container's local filesystem (e.g., `/tmp`), not on a mounted volume, because PM2's Unix sockets may not be supported on certain filesystems.

#### Method 1: Using docker run

```bash
# Create data directory and set permissions
mkdir -p /your/data/path
chown -R 1000:1000 /your/data/path  # 1000 is the default user ID in container

# Run as non-root user (PM2_HOME must be set)
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -e PM2_HOME=/tmp/.pm2 \
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
    environment:
      - PM2_HOME=/tmp/.pm2  # Required: Set PM2 working directory to local filesystem
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

### Known Limitations for Non-Root Users

When running Debian images as a non-root user, there are the following known limitations:

1. **Cannot create global command shortcuts**: The application attempts to create symbolic links for `ql` and `task` commands in `/usr/local/bin/`, but non-root users lack permissions. **This doesn't affect any functionality** - the application automatically uses full paths, and scheduled tasks and all features work normally.
2. **PM2_HOME must be configured correctly**: Must be set to the container's local filesystem (e.g., `/tmp/.pm2`), see configuration examples above.

### Troubleshooting

#### How to check current image version?

```bash
docker inspect qinglong | grep Image
```

#### PM2 Permission Errors (EACCES: permission denied)

If you see errors like:
```
Error: EACCES: permission denied, mkdir '/.pm2/logs'
Error: EACCES: permission denied, mkdir '/.pm2/pids'
```

**Cause**: PM2 uses `~/.pm2` as its default working directory, which non-root users may not have permission to write to.

**Solution**: Set the `PM2_HOME` environment variable to a writable directory on the container's local filesystem:

```bash
# Using docker run
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -e PM2_HOME=/tmp/.pm2 \
  -v /your/data/path:/ql/data \
  -p 5700:5700 \
  whyour/qinglong:debian

# Or add to docker-compose.yml
environment:
  - PM2_HOME=/tmp/.pm2
```

#### Symlink Permission Errors (/usr/local/bin)

If you see this error:
```
EACCES: permission denied, symlink '/ql/shell/update.sh' -> '/usr/local/bin/ql_tmp'
```

**Cause**: The application attempts to create symbolic links for `ql` and `task` commands in `/usr/local/bin/`, which requires root permissions.

**Impact**: This is a warning and **does not affect any functionality**. The application automatically detects if symlinks are available and uses full paths when they're not.

**Scheduled Tasks Auto-Adapt**:
- ✅ Scheduled tasks automatically use full paths (e.g., `/ql/shell/task.sh`)
- ✅ Web interface works completely normally
- ✅ All core functionality is unaffected
- ℹ️ Manual command-line usage requires full paths

**Solution**:
1. **Ignore this error** (recommended) - The application handles this automatically, everything works normally
2. **If you need to use `ql` and `task` commands in CLI** (for non-root users):

   **Method 1: Use Shell Aliases** (Recommended)
   ```bash
   # Execute inside container
   docker exec -it qinglong bash
   
   # Add aliases to ~/.bashrc
   echo 'alias ql="/ql/shell/update.sh"' >> ~/.bashrc
   echo 'alias task="/ql/shell/task.sh"' >> ~/.bashrc
   source ~/.bashrc
   
   # Now you can use commands directly
   ql update
   task script.js
   ```

   **Method 2: Add to User PATH**
   ```bash
   # Execute inside container
   docker exec -it qinglong bash
   
   # Create user bin directory
   mkdir -p ~/bin
   
   # Create symbolic links
   ln -sf /ql/shell/update.sh ~/bin/ql
   ln -sf /ql/shell/task.sh ~/bin/task
   
   # Add to PATH
   echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
   source ~/.bashrc
   
   # Now you can use commands directly
   ql update
   task script.js
   ```

   **Method 3: Use Full Paths**
   ```bash
   /ql/shell/update.sh  # Instead of: ql update
   /ql/shell/task.sh    # Instead of: task
   ```

#### PM2 Socket Errors (ENOTSUP)

If you see this error:
```
Error: connect ENOTSUP /ql/data/.pm2/rpc.sock
```

**Cause**: PM2 uses Unix domain sockets for inter-process communication. Some filesystems (network mounts, Windows volumes, certain NFS configurations) do not support Unix sockets.

**Solution**: Set `PM2_HOME` to the container's local filesystem (e.g., `/tmp`) instead of a mounted volume:

```bash
# Correct: Use container's local filesystem
-e PM2_HOME=/tmp/.pm2

# Incorrect: Using mounted volume (may not support Unix sockets)
-e PM2_HOME=/ql/data/.pm2
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

# 3. Create new container with Debian image (set PM2_HOME)
docker run -d \
# 3. Create new container with Debian image (set PM2_HOME)
docker run -d \
  --name qinglong \
  --user 1000:1000 \
  -e PM2_HOME=/tmp/.pm2 \
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
