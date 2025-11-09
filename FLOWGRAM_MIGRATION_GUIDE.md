# Flowgram Migration Guide - 从 React Flow 迁移到 Flowgram.ai

## 概述 (Overview)

本文档提供从 React Flow 迁移到 Flowgram.ai 的完整指南。

参考 Demo: https://github.com/bytedance/flowgram.ai/tree/main/apps/demo-free-layout

## 1. 依赖安装 (Dependencies Installation)

### 已添加的依赖 (Dependencies Added)

```json
{
  "@flowgram.ai/core": "^1.0.2",
  "@flowgram.ai/free-layout-editor": "^1.0.2",
  "@flowgram.ai/reactive": "^1.0.2",
  "@flowgram.ai/free-snap-plugin": "^1.0.2",
  "@flowgram.ai/free-lines-plugin": "^1.0.2",
  "@flowgram.ai/free-node-panel-plugin": "^1.0.2",
  "@flowgram.ai/minimap-plugin": "^1.0.2",
  "@flowgram.ai/free-container-plugin": "^1.0.2",
  "@flowgram.ai/free-group-plugin": "^1.0.2",
  "@flowgram.ai/form-materials": "^1.0.2",
  "@flowgram.ai/panel-manager-plugin": "^1.0.2",
  "@flowgram.ai/free-stack-plugin": "^1.0.2",
  "@flowgram.ai/runtime-interface": "^1.0.2",
  "@flowgram.ai/runtime-js": "^1.0.2",
  "nanoid": "^5.0.9"
}
```

### 安装命令 (Installation Command)

```bash
cd /home/runner/work/qinglong/qinglong
npm install --legacy-peer-deps
# or
pnpm install
```

## 2. 数据结构适配 (Data Structure Adaptation)

### 当前 React Flow 格式

```typescript
{
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 100, y: 100 },
      data: {
        label: "Webhook Trigger",
        triggerType: "webhook",
        config: {}
      }
    }
  ],
  edges: [
    {
      id: "e1",
      source: "trigger-1",
      target: "condition-1"
    }
  ]
}
```

### Flowgram 格式

```typescript
{
  nodes: [
    {
      id: "trigger_1",
      type: "trigger",
      meta: {
        position: { x: 100, y: 100 }
      },
      data: {
        title: "Webhook Trigger",
        triggerType: "webhook",
        config: {},
        // Flowgram 使用 inputs/outputs schema
        outputs: {
          type: "object",
          properties: {
            data: { type: "object" }
          }
        }
      }
    }
  ],
  edges: [
    {
      sourceNodeID: "trigger_1",
      targetNodeID: "condition_1"
    }
  ]
}
```

## 3. 节点注册系统 (Node Registry System)

### 节点注册接口 (Node Registry Interface)

```typescript
// src/pages/scenario/flowgram/types.ts
import { FlowNodeRegistry as FlowgramRegistry } from '@flowgram.ai/free-layout-editor';

export type FlowNodeRegistry = FlowgramRegistry;

export interface NodeData {
  title: string;
  inputs?: any;
  outputs?: any;
  inputsValues?: any;
  [key: string]: any;
}
```

### 创建节点注册 (Create Node Registries)

#### Start 节点 (src/pages/scenario/flowgram/nodes/start.tsx)

```typescript
import { FlowNodeRegistry } from '../types';

export const StartNodeRegistry: FlowNodeRegistry = {
  type: 'start',
  meta: {
    category: 'basic',
    label: '开始',
    description: '工作流开始节点',
  },
  data: {
    title: '开始',
    outputs: {
      type: 'object',
      properties: {
        triggerData: {
          type: 'object',
          description: '触发数据',
        },
      },
    },
  },
  formMeta: {
    properties: {
      title: {
        type: 'string',
        title: '标题',
      },
    },
  },
};
```

#### Trigger 节点 (src/pages/scenario/flowgram/nodes/trigger.tsx)

```typescript
export const TriggerNodeRegistry: FlowNodeRegistry = {
  type: 'trigger',
  meta: {
    category: 'triggers',
    label: '触发器',
    description: '各种触发器类型',
  },
  data: {
    title: '触发器',
    triggerType: 'webhook',
    outputs: {
      type: 'object',
      properties: {
        data: { type: 'object' },
      },
    },
  },
  formMeta: {
    properties: {
      title: {
        type: 'string',
        title: '标题',
      },
      triggerType: {
        type: 'string',
        title: '触发类型',
        enum: ['time', 'webhook', 'variable', 'task_status', 'system_event'],
        enumNames: ['时间触发', 'Webhook', '变量监听', '任务状态', '系统事件'],
      },
      config: {
        type: 'object',
        title: '配置',
        properties: {
          schedule: {
            type: 'string',
            title: 'Cron 表达式',
          },
          filePath: {
            type: 'string',
            title: '文件路径',
          },
        },
      },
    },
  },
};
```

#### Condition 节点

```typescript
export const ConditionNodeRegistry: FlowNodeRegistry = {
  type: 'condition',
  meta: {
    category: 'logic',
    label: '条件',
    description: '条件判断节点',
  },
  data: {
    title: '条件',
    conditions: [],
    outputs: {
      type: 'object',
      properties: {
        result: { type: 'boolean' },
      },
    },
  },
  formMeta: {
    properties: {
      title: { type: 'string', title: '标题' },
      operator: {
        type: 'string',
        title: '操作符',
        enum: ['equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'not_contains'],
        enumNames: ['等于', '不等于', '大于', '小于', '包含', '不包含'],
      },
      field: { type: 'string', title: '字段名' },
      value: { type: 'string', title: '比较值' },
    },
  },
};
```

#### Action 节点

```typescript
export const ActionNodeRegistry: FlowNodeRegistry = {
  type: 'action',
  meta: {
    category: 'actions',
    label: '动作',
    description: '执行动作',
  },
  data: {
    title: '动作',
    actionType: 'run_task',
  },
  formMeta: {
    properties: {
      title: { type: 'string', title: '标题' },
      actionType: {
        type: 'string',
        title: '动作类型',
        enum: ['run_task', 'set_variable', 'execute_command', 'send_notification'],
        enumNames: ['运行任务', '设置变量', '执行命令', '发送通知'],
      },
      cronId: { type: 'number', title: '任务 ID' },
      name: { type: 'string', title: '变量名' },
      value: { type: 'string', title: '变量值' },
      command: { type: 'string', title: '命令' },
      message: { type: 'string', title: '消息' },
    },
  },
};
```

#### Control 节点

```typescript
export const ControlNodeRegistry: FlowNodeRegistry = {
  type: 'control',
  meta: {
    category: 'control',
    label: '控制流',
    description: '控制流节点',
  },
  data: {
    title: '控制流',
    controlType: 'delay',
  },
  formMeta: {
    properties: {
      title: { type: 'string', title: '标题' },
      controlType: {
        type: 'string',
        title: '控制类型',
        enum: ['delay', 'retry', 'circuit_breaker'],
        enumNames: ['延迟', '重试', '熔断器'],
      },
      delaySeconds: { type: 'number', title: '延迟秒数' },
      maxRetries: { type: 'number', title: '最大重试次数' },
      retryDelay: { type: 'number', title: '重试延迟' },
      backoffMultiplier: { type: 'number', title: '退避倍数' },
      failureThreshold: { type: 'number', title: '失败阈值' },
    },
  },
};
```

#### Logic Gate 节点

```typescript
export const LogicGateNodeRegistry: FlowNodeRegistry = {
  type: 'logic_gate',
  meta: {
    category: 'logic',
    label: '逻辑门',
    description: 'AND/OR 逻辑',
  },
  data: {
    title: '逻辑门',
    gateType: 'AND',
  },
  formMeta: {
    properties: {
      title: { type: 'string', title: '标题' },
      gateType: {
        type: 'string',
        title: '逻辑类型',
        enum: ['AND', 'OR'],
        enumNames: ['AND', 'OR'],
      },
    },
  },
};
```

#### End 节点

```typescript
export const EndNodeRegistry: FlowNodeRegistry = {
  type: 'end',
  meta: {
    category: 'basic',
    label: '结束',
    description: '工作流结束节点',
  },
  data: {
    title: '结束',
    inputs: {
      type: 'object',
      properties: {
        result: { type: 'any' },
      },
    },
  },
  formMeta: {
    properties: {
      title: { type: 'string', title: '标题' },
    },
  },
};
```

## 4. 编辑器组件 (Editor Component)

### 主编辑器 (src/pages/scenario/flowgram/Editor.tsx)

```typescript
import React from 'react';
import { EditorRenderer, FreeLayoutEditorProvider } from '@flowgram.ai/free-layout-editor';
import '@flowgram.ai/free-layout-editor/index.css';
import { useEditorProps } from './hooks/useEditorProps';
import { nodeRegistries } from './nodes';

interface EditorProps {
  initialData: any;
  onSave: (data: any) => void;
}

export const FlowgramEditor: React.FC<EditorProps> = ({ initialData, onSave }) => {
  const editorProps = useEditorProps(initialData, nodeRegistries, onSave);
  
  return (
    <div style={{ width: '100%', height: '600px' }}>
      <FreeLayoutEditorProvider {...editorProps}>
        <EditorRenderer />
      </FreeLayoutEditorProvider>
    </div>
  );
};
```

### 编辑器配置 (src/pages/scenario/flowgram/hooks/useEditorProps.tsx)

```typescript
import { useMemo } from 'react';
import { FreeLayoutProps } from '@flowgram.ai/free-layout-editor';
import { createMinimapPlugin } from '@flowgram.ai/minimap-plugin';
import { createFreeSnapPlugin } from '@flowgram.ai/free-snap-plugin';
import { createFreeNodePanelPlugin } from '@flowgram.ai/free-node-panel-plugin';
import { createFreeLinesPlugin } from '@flowgram.ai/free-lines-plugin';
import { FlowNodeRegistry } from '../types';

export function useEditorProps(
  initialData: any,
  nodeRegistries: FlowNodeRegistry[],
  onSave: (data: any) => void
): FreeLayoutProps {
  return useMemo<FreeLayoutProps>(
    () => ({
      background: true,
      readonly: false,
      twoWayConnection: true,
      initialData,
      nodeRegistries,
      
      // 节点数据转换
      fromNodeJSON(node, json) {
        return json;
      },
      
      toNodeJSON(node, json) {
        return json;
      },
      
      // 连线颜色
      lineColor: {
        default: '#4d53e8',
        drawing: '#5DD6E3',
        hovered: '#37d0ff',
        selected: '#37d0ff',
        error: 'red',
      },
      
      // 连线规则
      canAddLine(ctx, fromPort, toPort) {
        if (fromPort.node === toPort.node) return false;
        return !fromPort.node.lines.allInputNodes.includes(toPort.node);
      },
      
      // 内容变化回调
      onContentChange: (ctx, event) => {
        if (ctx.document.disposed) return;
        const data = ctx.document.toJSON();
        onSave(data);
      },
      
      // 插件
      plugins: () => [
        createMinimapPlugin({}),
        createFreeSnapPlugin({}),
        createFreeNodePanelPlugin({}),
        createFreeLinesPlugin({}),
      ],
    }),
    [initialData, nodeRegistries, onSave]
  );
}
```

## 5. 模态框集成 (Modal Integration)

### 替换 visualWorkflowModal.tsx

```typescript
// src/pages/scenario/flowgramWorkflowModal.tsx
import React, { useState, useEffect } from 'react';
import { Modal } from 'antd';
import { FlowgramEditor } from './flowgram/Editor';
import intl from 'react-intl-universal';

interface FlowgramWorkflowModalProps {
  visible: boolean;
  scenario?: any;
  onOk: (scenario: any) => void;
  onCancel: () => void;
}

export const FlowgramWorkflowModal: React.FC<FlowgramWorkflowModalProps> = ({
  visible,
  scenario,
  onOk,
  onCancel,
}) => {
  const [workflowData, setWorkflowData] = useState<any>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    if (scenario) {
      setName(scenario.name || '');
      setWorkflowData(scenario.workflowGraph || getInitialData());
    } else {
      setName('');
      setWorkflowData(getInitialData());
    }
  }, [scenario, visible]);

  const getInitialData = () => ({
    nodes: [
      {
        id: 'start_0',
        type: 'start',
        meta: { position: { x: 100, y: 300 } },
        data: { title: '开始' },
      },
      {
        id: 'end_0',
        type: 'end',
        meta: { position: { x: 800, y: 300 } },
        data: { title: '结束' },
      },
    ],
    edges: [],
  });

  const handleSave = (data: any) => {
    setWorkflowData(data);
  };

  const handleOk = () => {
    onOk({
      ...scenario,
      name,
      workflowGraph: workflowData,
    });
  };

  return (
    <Modal
      title={scenario ? intl.get('编辑场景') : intl.get('新建场景')}
      open={visible}
      onOk={handleOk}
      onCancel={onCancel}
      width="90%"
      style={{ top: 20 }}
    >
      <div style={{ marginBottom: 16 }}>
        <input
          placeholder="场景名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: '100%', padding: '8px' }}
        />
      </div>
      {workflowData && (
        <FlowgramEditor
          initialData={workflowData}
          onSave={handleSave}
        />
      )}
    </Modal>
  );
};
```

## 6. 在主页面中使用 (Usage in Main Page)

### 更新 index.tsx

```typescript
// src/pages/scenario/index.tsx
import { FlowgramWorkflowModal } from './flowgramWorkflowModal';

// 替换原来的
// import { VisualWorkflowModal } from './visualWorkflowModal';

// 使用
<FlowgramWorkflowModal
  visible={modalVisible}
  scenario={editingScenario}
  onOk={handleSaveScenario}
  onCancel={() => setModalVisible(false)}
/>
```

## 7. 后端兼容性 (Backend Compatibility)

### 数据转换工具 (Data Conversion)

```typescript
// src/pages/scenario/flowgram/utils/dataConverter.ts

/**
 * 将 Flowgram 格式转换为后端格式
 */
export function convertFlowgramToBackend(flowgramData: any) {
  return {
    nodes: flowgramData.nodes.map((node: any) => ({
      id: node.id,
      type: node.type,
      position: node.meta?.position || { x: 0, y: 0 },
      data: node.data,
    })),
    edges: flowgramData.edges.map((edge: any) => ({
      id: `${edge.sourceNodeID}-${edge.targetNodeID}`,
      source: edge.sourceNodeID,
      target: edge.targetNodeID,
      sourcePort: edge.sourcePortID,
    })),
  };
}

/**
 * 将后端格式转换为 Flowgram 格式
 */
export function convertBackendToFlowgram(backendData: any) {
  return {
    nodes: backendData.nodes.map((node: any) => ({
      id: node.id,
      type: node.type,
      meta: {
        position: node.position,
      },
      data: node.data,
    })),
    edges: backendData.edges.map((edge: any) => ({
      sourceNodeID: edge.source,
      targetNodeID: edge.target,
      sourcePortID: edge.sourcePort,
    })),
  };
}
```

## 8. CSS 样式 (Styles)

### 导入 Flowgram 样式

```typescript
// src/pages/scenario/flowgram/Editor.tsx
import '@flowgram.ai/free-layout-editor/index.css';

// 自定义样式
const customStyles = `
  .flowgram-editor {
    width: 100%;
    height: 600px;
    border: 1px solid #d9d9d9;
    border-radius: 4px;
  }
`;
```

## 9. 测试清单 (Testing Checklist)

- [ ] 依赖安装成功
- [ ] 节点可以正常创建和拖拽
- [ ] 节点可以连接
- [ ] 节点配置面板正常显示
- [ ] 保存功能正常
- [ ] 与后端图执行引擎兼容
- [ ] 可以编辑现有场景
- [ ] 所有节点类型都可用

## 10. 故障排查 (Troubleshooting)

### 常见问题

**Q: Flowgram 插件包无法安装**
A: 使用 `npm install --legacy-peer-deps` 或 `pnpm install`

**Q: TypeScript 类型错误**
A: 添加类型声明文件或使用 `// @ts-ignore`

**Q: 样式不显示**
A: 确保导入了 `@flowgram.ai/free-layout-editor/index.css`

**Q: 节点不显示**
A: 检查节点注册是否正确，formMeta 是否完整

## 11. 参考资源 (Resources)

- Flowgram 官方 Demo: https://github.com/bytedance/flowgram.ai/tree/main/apps/demo-free-layout
- Flowgram 文档: https://flowgram.ai/
- 当前实现: src/pages/scenario/visualWorkflowModal.tsx (React Flow 版本)

## 总结 (Summary)

这个迁移涉及：
1. 替换依赖包（React Flow -> Flowgram）
2. 重写节点注册系统
3. 重新实现编辑器组件
4. 适配数据格式
5. 保持后端兼容性

预计工作量：8-12 小时
难度：中等
风险：中等（主要是 Flowgram 文档不完整）
