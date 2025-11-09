// Custom Node Type Definitions for Flowgram Workflow Editor
import React from 'react';
import { Tag } from 'antd';

export interface NodeData {
  label: string;
  [key: string]: any;
}

export interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: NodeData;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// Trigger Node Types
export const TriggerNodeTypes = {
  TIME: 'time',
  WEBHOOK: 'webhook',
  VARIABLE: 'variable',
  TASK_STATUS: 'task_status',
  SYSTEM_EVENT: 'system_event',
};

// Condition Node Types
export const ConditionNodeTypes = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  GREATER_THAN: 'greater_than',
  LESS_THAN: 'less_than',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'not_contains',
};

// Action Node Types
export const ActionNodeTypes = {
  RUN_TASK: 'run_task',
  SET_VARIABLE: 'set_variable',
  EXECUTE_COMMAND: 'execute_command',
  SEND_NOTIFICATION: 'send_notification',
};

// Control Flow Node Types
export const ControlFlowNodeTypes = {
  DELAY: 'delay',
  RETRY: 'retry',
  CIRCUIT_BREAKER: 'circuit_breaker',
  AND_GATE: 'and_gate',
  OR_GATE: 'or_gate',
};

// Node Renderer Components
export const NodeRenderers = {
  trigger: (node: WorkflowNode) => (
    <div
      style={{
        padding: '12px 16px',
        background: '#1890ff',
        color: 'white',
        borderRadius: 6,
        minWidth: 160,
        boxShadow: '0 2px 8px rgba(24, 144, 255, 0.3)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{node.data.label}</div>
      <Tag
        style={{
          background: 'rgba(255, 255, 255, 0.2)',
          border: 'none',
          color: 'white',
        }}
      >
        {node.data.triggerType || 'trigger'}
      </Tag>
    </div>
  ),

  condition: (node: WorkflowNode) => (
    <div
      style={{
        padding: '12px 16px',
        background: '#52c41a',
        color: 'white',
        borderRadius: 6,
        minWidth: 160,
        boxShadow: '0 2px 8px rgba(82, 196, 26, 0.3)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{node.data.label}</div>
      <div style={{ fontSize: 12, opacity: 0.9 }}>
        {node.data.field} {node.data.operator} {node.data.value}
      </div>
    </div>
  ),

  action: (node: WorkflowNode) => (
    <div
      style={{
        padding: '12px 16px',
        background: '#fa8c16',
        color: 'white',
        borderRadius: 6,
        minWidth: 160,
        boxShadow: '0 2px 8px rgba(250, 140, 22, 0.3)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{node.data.label}</div>
      <Tag
        style={{
          background: 'rgba(255, 255, 255, 0.2)',
          border: 'none',
          color: 'white',
        }}
      >
        {node.data.actionType || 'action'}
      </Tag>
    </div>
  ),

  control: (node: WorkflowNode) => (
    <div
      style={{
        padding: '12px 16px',
        background: '#722ed1',
        color: 'white',
        borderRadius: 6,
        minWidth: 160,
        boxShadow: '0 2px 8px rgba(114, 46, 209, 0.3)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{node.data.label}</div>
      <div style={{ fontSize: 12, opacity: 0.9 }}>
        {node.data.controlType || 'control'}
      </div>
    </div>
  ),

  logic_gate: (node: WorkflowNode) => (
    <div
      style={{
        padding: '12px 16px',
        background: '#13c2c2',
        color: 'white',
        borderRadius: 6,
        minWidth: 120,
        textAlign: 'center',
        boxShadow: '0 2px 8px rgba(19, 194, 194, 0.3)',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 16 }}>
        {node.data.gateType || 'AND'}
      </div>
    </div>
  ),
};

// Helper function to create a new node
export const createNode = (
  type: string,
  position: { x: number; y: number },
  data: Partial<NodeData>,
): WorkflowNode => {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type,
    position,
    data: {
      label: data.label || type,
      ...data,
    },
  };
};

// Helper function to create a new edge
export const createEdge = (
  source: string,
  target: string,
): WorkflowEdge => {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
  };
};

// Node templates for quick creation
export const NodeTemplates = {
  triggers: {
    time: {
      label: '时间触发',
      triggerType: 'time',
      config: { schedule: '0 0 * * *' },
    },
    webhook: {
      label: 'Webhook触发',
      triggerType: 'webhook',
      config: {},
    },
    variable: {
      label: '变量监听',
      triggerType: 'variable',
      config: { watchPath: '' },
    },
    task_status: {
      label: '任务状态',
      triggerType: 'task_status',
      config: { cronId: null },
    },
    system_event: {
      label: '系统事件',
      triggerType: 'system_event',
      config: { eventType: 'disk_space', threshold: 80 },
    },
  },
  conditions: {
    equals: {
      label: '等于判断',
      operator: 'equals',
      field: '',
      value: '',
    },
    greater_than: {
      label: '大于判断',
      operator: 'greater_than',
      field: '',
      value: 0,
    },
    contains: {
      label: '包含判断',
      operator: 'contains',
      field: '',
      value: '',
    },
  },
  actions: {
    run_task: {
      label: '运行任务',
      actionType: 'run_task',
      cronId: null,
    },
    set_variable: {
      label: '设置变量',
      actionType: 'set_variable',
      name: '',
      value: '',
    },
    execute_command: {
      label: '执行命令',
      actionType: 'execute_command',
      command: '',
    },
    send_notification: {
      label: '发送通知',
      actionType: 'send_notification',
      message: '',
    },
  },
  controls: {
    delay: {
      label: '延迟执行',
      controlType: 'delay',
      delaySeconds: 60,
    },
    retry: {
      label: '重试策略',
      controlType: 'retry',
      maxRetries: 3,
      retryDelay: 5,
      backoffMultiplier: 2,
    },
    circuit_breaker: {
      label: '熔断器',
      controlType: 'circuit_breaker',
      failureThreshold: 3,
    },
  },
  logic_gates: {
    and: {
      label: 'AND',
      gateType: 'AND',
    },
    or: {
      label: 'OR',
      gateType: 'OR',
    },
  },
};
