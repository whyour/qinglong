# QingLong - Node.js 原生部署指南

本文档说明如何在 Linux 服务器上以 Node.js 原生方式编译、部署和运行青龙面板，使用 Python venv 隔离环境。

## 一、环境要求

### 本地构建环境（macOS / Linux）

- Node.js 20.x
- pnpm 8.3.1
- Python 3.x

### 服务器运行环境

- Node.js 16+
- Python 3 + python3-venv
- nginx
- jq、curl、git
- pm2（全局安装）

## 二、本地编译

```bash
# 克隆项目
git clone https://github.com/whyour/qinglong.git
cd qinglong

# 安装依赖
npm i -g pnpm@8.3.1
pnpm install

# 创建本地 venv（可选，仅本地开发需要）
python3 -m venv .venv

# 构建前端
pnpm build:front

# 构建后端
pnpm build:back
```

构建产物：

```
static/
├── build/          ← 后端编译产物（tsc）
│   └── app.js      ← pm2 入口
└── dist/           ← 前端构建产物（umi）
    ├── index.html
    └── ...
```

## 三、打包上传

### 打包（不含 node_modules，约 12MB）

```bash
COPYFILE_DISABLE=1 tar czf qinglong-deploy.tar.gz \
  --exclude='node_modules' \
  static/ shell/ sample/ back/protos/ \
  package.json pnpm-lock.yaml ecosystem.config.js .env.example version.yaml
```

### 上传到服务器

```bash
scp qinglong-deploy.tar.gz user@server:~/
```

## 四、服务器部署

### 4.1 解压并安装依赖

```bash
mkdir -p ~/qinglong
tar xzf qinglong-deploy.tar.gz -C ~/qinglong
cd ~/qinglong

# 安装 pnpm（如果没有）
npm i -g pnpm@8.3.1

# 安装生产依赖
pnpm install --prod
```

### 4.2 首次启动

```bash
export QL_DIR=$(pwd)
export QL_DATA_DIR="${QL_DIR}/data"
bash shell/start-simplify.sh
```

首次启动会自动：

1. 读取 `.env` 配置（不存在则从 `.env.example` 复制）
2. 创建 Python venv（`${QL_DIR}/.venv`）
3. 安装 `requests` 到 venv
4. 修复 `task` / `ql` 命令软链接
5. 启动 nginx + pm2

访问 `http://服务器IP:5700` 即可。

### 4.3 配置 systemctl 开机自启

```bash
sudo tee /etc/systemd/system/qinglong.service << 'EOF'
[Unit]
Description=QingLong Panel
After=network.target

[Service]
Type=forking
WorkingDirectory=/home/jiandanc/qinglong
Environment="QL_DIR=/home/jiandanc/qinglong"
Environment="QL_DATA_DIR=/home/jiandanc/qinglong/data"
ExecStart=/bin/bash /home/jiandanc/qinglong/shell/start-simplify.sh
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# 重载配置
sudo systemctl daemon-reload

# 启动服务
sudo systemctl start qinglong

# 设置开机自启
sudo systemctl enable qinglong

# 查看状态
sudo systemctl status qinglong

# 查看日志
sudo journalctl -u qinglong -f
```

> **注意**：`WorkingDirectory`、`QL_DIR`、`QL_DATA_DIR` 需要替换为你的实际部署路径。

## 五、目录结构

部署后的完整目录结构：

```
~/qinglong/                      ← QL_DIR
├── .venv/                       ← Python 虚拟环境（自动创建）
│   ├── bin/
│   │   ├── python3
│   │   └── pip3
│   └── lib/
├── data/                        ← QL_DATA_DIR（运行数据）
│   ├── config/                  ← 配置文件
│   │   ├── config.sh            ← 用户配置
│   │   └── crontab.list         ← 定时任务列表
│   ├── scripts/                 ← 用户脚本
│   ├── log/                     ← 运行日志
│   ├── db/                      ← 数据库
│   ├── deps/                    ← 依赖缓存
│   └── dep_cache/
│       └── node/                ← Node 依赖缓存
├── static/
│   ├── build/                   ← 后端编译产物
│   └── dist/                    ← 前端构建产物
├── shell/
│   ├── start.sh                 ← 完整启动脚本（含系统依赖安装）
│   ├── start-simplify.sh        ← 精简启动脚本（跳过系统依赖安装）
│   ├── task.sh                  ← 定时任务执行脚本
│   └── update.sh                ← 更新脚本（ql 命令）
├── sample/                      ← 配置模板
├── back/protos/                 ← gRPC proto 文件
├── ecosystem.config.js          ← pm2 配置
├── package.json
└── .env                         ← 环境变量（Node.js 读取）
```

## 六、Python venv 说明

### 工作原理

启动脚本将 `.venv/bin` 加入 `PATH` 最前面，使所有 `python3` / `pip3` 调用自动指向 venv，无需修改 `task.sh` 等原有脚本。

### 环境变量解析优先级

```
1. export PYTHON_VENV_DIR=/path     ← 手动 export（最高优先级）
2. .env 中 PYTHON_VENV_DIR=./.venv  ← 启动脚本从 .env 读取
3. ${QL_DIR}/.venv                   ← 默认值（兜底）
```

### 不设置的变量

以下变量**不应设置**，否则会破坏 venv 的包解析机制：

- `PYTHONHOME` — 会覆盖 Python 的 prefix 解析
- `PYTHONUSERBASE` — venv 不需要
- `PYTHONPATH` — venv 通过 `pyvenv.cfg` 自动管理

### 验证 venv 是否生效

```bash
# 查看 Python 路径
which python3
# 预期: ~/qinglong/.venv/bin/python3

# 验证是否在 venv 中
python3 -c "import sys; print('✅ venv' if sys.prefix != sys.base_prefix else '❌ 系统')"
```

## 七、本地开发模式

```bash
cd qinglong

# 创建 venv
python3 -m venv .venv

# 安装依赖
pnpm install

# 启动（前端 8000 端口，后端 5700 端口）
pnpm start
```

开发模式下 `pnpm start` 会自动 source `shell/dev-env.sh` 设置 venv 环境。

## 八、常用运维命令

```bash
# 查看服务状态
sudo systemctl status qinglong

# 重启服务
sudo systemctl restart qinglong

# 查看日志
sudo journalctl -u qinglong -f

# 查看 pm2 状态
sudo pm2 list

# 查看 pm2 日志
sudo pm2 logs

# 手动运行任务
cd ~/qinglong
QL_DIR=$(pwd) QL_DATA_DIR="$(pwd)/data" bash shell/task.sh <脚本名> now

# 更新 qinglong（重新编译后替换 static/ 目录，重启服务）
sudo systemctl restart qinglong
```

## 九、常见问题

### Q: 网页运行任务一直显示"运行中"

检查 `task` 软链接是否指向正确目录：

```bash
ls -la /usr/local/bin/task
# 应该指向 ~/qinglong/shell/task.sh，不是 npm 全局路径
```

修复：

```bash
sudo ln -sf ~/qinglong/shell/task.sh /usr/local/bin/task
sudo pm2 restart qinglong
```

### Q: 安装 Python 依赖报权限错误

```bash
sudo chown -R $(whoami) ~/qinglong/.venv
```

### Q: sudo 运行后普通用户无权限

```bash
sudo chown -R $(whoami) ~/qinglong/data
```

### Q: systemctl 日志为空

确保 service 文件中包含：

```ini
StandardOutput=journal
StandardError=journal
```

然后 `sudo systemctl daemon-reload && sudo systemctl restart qinglong`。
