# Flowgram 可视化工作流集成进度 (Flowgram Visual Workflow Integration Progress)

## 当前状态 (Current Status)

### ✅ 已完成 (Completed - Commit: fffc1e4)

1. **依赖安装** (Dependencies Installed)
   - `@flowgram.ai/free-layout-editor@1.0.2`
   - `@flowgram.ai/core@1.0.2`
   - `@flowgram.ai/reactive@1.0.2`

2. **数据模型更新** (Data Model Updates)
   - 添加 `workflowGraph` 字段到 Scenario 模型
   - 保留旧字段以保持向后兼容
   - 数据库迁移脚本已更新

3. **API 层更新** (API Layer Updates)
   - `triggerType` 从必需改为可选
   - 添加 `workflowGraph` 参数支持
   - Create 和 Update 端点已更新

4. **前端基础** (Frontend Foundation)
   - 创建新的 `flowgramModal.tsx` 组件
   - 主页面更新使用新的模态框
   - 基础工作流结构定义

### 🔄 需要完成 (To Be Completed)

#### 1. 完善 Flowgram 编辑器集成 (Complete Flowgram Editor Integration)

**当前问题**: Flowgram.ai 的详细 API 文档不完全公开。需要：
- 研究 Flowgram API 的正确使用方式
- 实现自定义节点渲染器
- 添加节点工具栏和配置面板

**临时方案**: 
- 可以使用 React Flow 或其他开源流程图库作为替代
- 或等待 Flowgram 官方文档/示例

#### 2. 自定义节点类型实现 (Custom Node Types)

需要实现以下节点类型：

```typescript
// Trigger Nodes (触发器节点)
- TimeT riggerNode: 时间触发配置
- WebhookTriggerNode: Webhook 触发配置
- VariableTriggerNode: 变量监听配置
- TaskStatusTriggerNode: 任务状态触发
- SystemEventTriggerNode: 系统事件触发

// Condition Nodes (条件节点)
- ConditionNode: 条件判断配置
- LogicGateNode: AND/OR 逻辑门

// Action Nodes (动作节点)
- RunTaskNode: 运行任务配置
- SetVariableNode: 设置变量配置
- ExecuteCommandNode: 执行命令配置
- SendNotificationNode: 发送通知配置

// Control Flow Nodes (控制流节点)
- DelayNode: 延迟执行
- RetryNode: 重试策略
- CircuitBreakerNode: 熔断器
```

#### 3. 节点配置面板 (Node Configuration Panels)

每个节点类型需要自己的配置表单：
- 双击节点打开配置面板
- 表单验证
- 实时预览

#### 4. 后端执行引擎重写 (Backend Execution Engine Rewrite)

当前 `ScenarioService.executeScenario()` 是线性执行。需要：

```typescript
// 新的图执行引擎
class GraphExecutor {
  async execute(workflowGraph: any, triggerData: any) {
    // 1. 查找入口节点（触发器节点）
    // 2. 遍历图结构
    // 3. 评估条件节点
    // 4. 执行动作节点
    // 5. 处理分支和合并
    // 6. 记录执行轨迹
  }
}
```

#### 5. 工作流验证 (Workflow Validation)

- 检查是否有有效的触发器节点
- 验证节点连接的完整性
- 检测循环
- 验证节点配置

#### 6. 测试和调试 (Testing & Debugging)

- 单元测试
- 集成测试
- UI 测试
- 性能测试

## 实现建议 (Implementation Recommendations)

### 方案 A: 完整 Flowgram 集成 (推荐如有文档)
如果能获取 Flowgram 完整文档和示例：
1. 参考官方示例实现自定义节点
2. 使用 Flowgram 的插件系统
3. 利用 Flowgram 的内置功能

### 方案 B: 使用 React Flow (备选方案)
如果 Flowgram 文档不足：
1. 使用 React Flow (`reactflow` npm package)
2. 成熟的文档和社区支持
3. 更容易实现自定义节点
4. 保持相同的数据结构

### 方案 C: 混合方案
1. 前端继续改进表单界面
2. 后端同时支持表单数据和图数据
3. 渐进式迁移

## 预估工作量 (Estimated Effort)

- **方案 A** (Flowgram): 20-30 小时（假设有文档）
- **方案 B** (React Flow): 15-20 小时
- **方案 C** (渐进式): 10-15 小时初始，后续持续

## 下一步建议 (Next Steps Recommendations)

1. **立即**: 确认是否有 Flowgram 官方文档或示例代码
2. **短期**: 实现一个简单的节点（如触发器节点）作为 POC
3. **中期**: 完成所有节点类型和配置面板
4. **长期**: 重写执行引擎并测试

## 技术债务注意 (Technical Debt Notes)

- 旧的表单数据结构被标记为 deprecated 但仍保留
- 需要在未来版本中清理
- 数据库包含两套结构的字段

## 联系和协作 (Contact & Collaboration)

如需加速开发，建议：
1. 获取 Flowgram 官方支持或文档
2. 提供 Flowgram 集成的参考示例
3. 或考虑使用 React Flow 等替代方案
