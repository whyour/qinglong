# 场景模式功能文档 (Scenario Mode Documentation)

## 概述 (Overview)

场景模式是青龙面板的一个强大功能扩展，支持基于条件的自动化工作流。通过场景模式，您可以创建智能的自动化任务，响应各种触发器并执行相应的动作。

Scenario Mode is a powerful feature extension for Qinglong panel, supporting conditional automated workflows. With Scenario Mode, you can create intelligent automation tasks that respond to various triggers and execute corresponding actions.

## 功能特性 (Features)

### 1. 多样化触发器 (Diverse Triggers)

#### 变量监听 (Variable Monitor)
- 监控指定路径的文件变化
- 当配置文件或环境变量文件发生变化时自动触发
- 适用场景：配置文件热加载、环境变量同步等

#### Webhook 触发器 (Webhook Trigger)
- 提供唯一的 HTTP 端点接收外部触发
- 支持 POST 请求传递触发数据
- 适用场景：第三方系统集成、CI/CD 流程集成等

#### 任务状态触发器 (Task Status Trigger)
- 基于其他定时任务的执行状态触发
- 可在任务成功或失败时执行相应动作
- 适用场景：任务链、失败告警、成功后续处理等

#### 时间触发器 (Time Trigger)
- 使用标准 Cron 表达式定时触发
- 支持灵活的时间调度
- 适用场景：定期检查、定时清理、周期性任务等

#### 系统事件触发器 (System Event Trigger)
- 监控系统资源使用情况
- 支持磁盘使用率和内存使用率监控
- 达到设定阈值时自动触发
- 适用场景：资源告警、自动清理、容量管理等

### 2. 条件逻辑引擎 (Condition Logic Engine)

- 支持多条件组合，使用 AND 或 OR 逻辑
- 灵活的条件表达式：
  - 等于 (equals)
  - 不等于 (not_equals)
  - 大于 (greater_than)
  - 小于 (less_than)
  - 包含 (contains)
  - 不包含 (not_contains)
- 支持嵌套字段访问（使用点号分隔，如 `data.user.name`）

### 3. 动作执行引擎 (Action Execution Engine)

#### 运行任务 (Run Task)
- 执行指定的定时任务
- 通过任务 ID 引用

#### 设置变量 (Set Variable)
- 动态设置环境变量
- 自动更新环境配置

#### 执行命令 (Execute Command)
- 执行自定义 Shell 命令
- 获取命令输出

#### 发送通知 (Send Notification)
- 发送通知消息
- 可集成现有通知系统

### 4. 高级特性 (Advanced Features)

#### 延迟执行 (Delayed Execution)
- 在触发后延迟指定秒数执行
- 避免频繁触发

#### 失败熔断 (Failure Circuit Breaker)
- 设置连续失败阈值
- 达到阈值后自动禁用场景
- 防止资源浪费和错误累积

#### 自适应重试 (Adaptive Retry)
- 配置最大重试次数
- 设置重试延迟
- 支持退避倍数（每次重试延迟递增）
- 根据错误类型灵活调整

#### 执行日志 (Execution Logs)
- 记录每次触发和执行的详细信息
- 包括触发数据、条件匹配结果、执行状态、错误信息
- 支持按场景查询历史日志

## 使用指南 (Usage Guide)

### 创建场景 (Creating a Scenario)

1. 进入"场景模式"页面
2. 点击"新建场景"按钮
3. 填写基本信息：
   - 名称：场景的标识名称
   - 描述：场景的详细说明（可选）

4. 配置触发器：
   - 选择触发类型
   - 根据触发类型填写相应配置

5. 配置条件（可选）：
   - 选择条件逻辑（AND/OR）
   - 添加多个条件
   - 每个条件包含字段名、操作符和值

6. 配置动作：
   - 至少添加一个动作
   - 根据动作类型填写相应参数

7. 高级设置（可选）：
   - 延迟执行时间
   - 失败熔断阈值
   - 重试策略

8. 保存场景

### Webhook 使用示例 (Webhook Usage Example)

```bash
# 1. 创建 Webhook 类型的场景
# 2. 获取 Webhook URL（点击"获取 Webhook"按钮）
# 3. 使用 curl 或其他工具发送请求

curl -X POST https://your-domain/api/scenarios/webhook/YOUR_TOKEN \
  -H "Content-Type: application/json" \
  -d '{
    "event": "deployment",
    "status": "success",
    "branch": "main"
  }'
```

### 条件配置示例 (Condition Configuration Examples)

#### 示例 1：检查事件类型
```
字段名: event
操作符: equals
值: deployment
```

#### 示例 2：检查状态和分支（AND 逻辑）
```
条件逻辑: AND

条件 1:
  字段名: status
  操作符: equals
  值: success

条件 2:
  字段名: branch
  操作符: equals
  值: main
```

#### 示例 3：多分支支持（OR 逻辑）
```
条件逻辑: OR

条件 1:
  字段名: branch
  操作符: equals
  值: main

条件 2:
  字段名: branch
  操作符: equals
  值: develop
```

### 动作配置示例 (Action Configuration Examples)

#### 示例 1：执行任务
```
动作类型: 运行任务
任务 ID: 123
```

#### 示例 2：设置环境变量
```
动作类型: 设置变量
变量名: DEPLOY_STATUS
变量值: completed
```

#### 示例 3：执行清理命令
```
动作类型: 执行命令
命令: rm -rf /tmp/cache/*
```

## API 接口 (API Endpoints)

### 场景管理 (Scenario Management)

- `GET /api/scenarios` - 获取场景列表
- `POST /api/scenarios` - 创建场景
- `PUT /api/scenarios` - 更新场景
- `DELETE /api/scenarios` - 删除场景
- `POST /api/scenarios/:id/trigger` - 手动触发场景
- `GET /api/scenarios/:id/webhook` - 获取 Webhook URL

### 日志查询 (Log Query)

- `GET /api/scenarios/logs?scenarioId={id}&limit={limit}` - 查询场景日志

### Webhook 端点 (Webhook Endpoint)

- `POST /api/scenarios/webhook/:token` - Webhook 触发端点

## 最佳实践 (Best Practices)

1. **合理设置失败熔断阈值**
   - 建议设置为 3-5 次
   - 避免长时间重复执行失败的场景

2. **使用条件过滤不必要的执行**
   - 添加精确的条件判断
   - 减少无效触发

3. **监控执行日志**
   - 定期检查场景执行情况
   - 及时发现和处理异常

4. **合理使用延迟执行**
   - 避免高频触发导致的系统负载
   - 给外部系统足够的处理时间

5. **配置适当的重试策略**
   - 对临时性错误启用重试
   - 使用退避倍数避免频繁重试

6. **保护敏感的 Webhook**
   - 使用复杂的 Token
   - 限制来源 IP（如需要）
   - 添加必要的条件验证

## 注意事项 (Notes)

1. 变量监听功能需要读取文件系统权限
2. 系统事件监控会定期执行检查，可能产生额外的系统开销
3. Webhook Token 在场景创建后不可更改，如需更换请重建场景
4. 执行命令动作需要谨慎使用，确保命令安全可靠
5. 建议在生产环境使用前先在测试环境验证场景配置

## 故障排查 (Troubleshooting)

### 场景未触发
1. 检查场景是否启用
2. 验证触发器配置是否正确
3. 查看场景执行日志

### 条件未匹配
1. 检查字段名是否正确（区分大小写）
2. 验证操作符和值的类型匹配
3. 查看触发数据的实际内容

### 动作执行失败
1. 检查动作配置参数
2. 验证引用的任务 ID 是否存在
3. 确认命令语法正确
4. 查看详细的错误信息

### Webhook 无法访问
1. 确认场景触发类型为 Webhook
2. 检查 Token 是否正确
3. 验证请求格式（Content-Type: application/json）

## 更新日志 (Changelog)

### Version 1.0.0 (2025-11-08)
- ✨ 初始版本发布
- ✨ 支持 5 种触发器类型
- ✨ 支持 4 种动作类型
- ✨ 完整的条件逻辑引擎
- ✨ 失败熔断和重试机制
- ✨ 执行日志记录
- ✨ 中英文双语支持

## 贡献 (Contributing)

欢迎提交问题和建议！

Welcome to submit issues and suggestions!

## 许可证 (License)

遵循青龙面板的开源许可证

Follows the Qinglong panel's open source license
