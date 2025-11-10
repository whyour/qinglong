// Flowgram Node Registry
import { nanoid } from 'nanoid';
import type { 
  StartNodeData, 
  TriggerNodeData, 
  ConditionNodeData, 
  ActionNodeData, 
  ControlNodeData, 
  LogicGateNodeData,
  EndNodeData,
  FlowgramNode
} from '../types';

// Node creation helpers
export function createStartNode(x: number = 100, y: number = 100): FlowgramNode {
  return {
    id: `start-${nanoid(8)}`,
    type: 'start',
    position: { x, y },
    data: {
      label: '开始',
    } as StartNodeData,
  };
}

export function createTriggerNode(triggerType: string, x: number = 200, y: number = 100): FlowgramNode {
  const labels: Record<string, string> = {
    time: '时间触发',
    webhook: 'Webhook触发',
    variable_monitor: '变量监听',
    task_status: '任务状态',
    system_event: '系统事件',
  };
  
  return {
    id: `trigger-${nanoid(8)}`,
    type: 'trigger',
    position: { x, y },
    data: {
      label: labels[triggerType] || '触发器',
      triggerType,
      config: {},
    } as TriggerNodeData,
  };
}

export function createConditionNode(x: number = 300, y: number = 100): FlowgramNode {
  return {
    id: `condition-${nanoid(8)}`,
    type: 'condition',
    position: { x, y },
    data: {
      label: '条件判断',
      operator: 'equals',
      field: '',
      value: '',
    } as ConditionNodeData,
  };
}

export function createActionNode(actionType: string, x: number = 400, y: number = 100): FlowgramNode {
  const labels: Record<string, string> = {
    run_task: '运行任务',
    set_variable: '设置变量',
    execute_command: '执行命令',
    send_notification: '发送通知',
  };
  
  return {
    id: `action-${nanoid(8)}`,
    type: 'action',
    position: { x, y },
    data: {
      label: labels[actionType] || '动作',
      actionType,
    } as ActionNodeData,
  };
}

export function createControlNode(controlType: string, x: number = 500, y: number = 100): FlowgramNode {
  const labels: Record<string, string> = {
    delay: '延迟执行',
    retry: '重试策略',
    circuit_breaker: '熔断器',
  };
  
  return {
    id: `control-${nanoid(8)}`,
    type: 'control',
    position: { x, y },
    data: {
      label: labels[controlType] || '控制流',
      controlType,
    } as ControlNodeData,
  };
}

export function createLogicGateNode(gateType: 'AND' | 'OR', x: number = 300, y: number = 200): FlowgramNode {
  return {
    id: `gate-${nanoid(8)}`,
    type: 'logic_gate',
    position: { x, y },
    data: {
      label: gateType === 'AND' ? '逻辑与' : '逻辑或',
      gateType,
    } as LogicGateNodeData,
  };
}

export function createEndNode(x: number = 600, y: number = 100): FlowgramNode {
  return {
    id: `end-${nanoid(8)}`,
    type: 'end',
    position: { x, y },
    data: {
      label: '结束',
    } as EndNodeData,
  };
}

// Node templates for quick creation
export const nodeTemplates = {
  start: () => createStartNode(),
  
  // Trigger templates
  'trigger-time': () => createTriggerNode('time'),
  'trigger-webhook': () => createTriggerNode('webhook'),
  'trigger-variable': () => createTriggerNode('variable_monitor'),
  'trigger-task': () => createTriggerNode('task_status'),
  'trigger-system': () => createTriggerNode('system_event'),
  
  // Condition template
  condition: () => createConditionNode(),
  
  // Action templates
  'action-run': () => createActionNode('run_task'),
  'action-variable': () => createActionNode('set_variable'),
  'action-command': () => createActionNode('execute_command'),
  'action-notify': () => createActionNode('send_notification'),
  
  // Control templates
  'control-delay': () => createControlNode('delay'),
  'control-retry': () => createControlNode('retry'),
  'control-breaker': () => createControlNode('circuit_breaker'),
  
  // Logic gate templates
  'gate-and': () => createLogicGateNode('AND'),
  'gate-or': () => createLogicGateNode('OR'),
  
  end: () => createEndNode(),
};

export type NodeTemplate = keyof typeof nodeTemplates;
