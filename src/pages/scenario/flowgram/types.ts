// Flowgram Types for Qinglong Scenario Mode

export interface FlowgramNodeData {
  label: string;
  [key: string]: any;
}

export interface FlowgramNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: FlowgramNodeData;
}

export interface FlowgramEdge {
  id: string;
  source: string;
  target: string;
  [key: string]: any;
}

export interface FlowgramGraph {
  nodes: FlowgramNode[];
  edges: FlowgramEdge[];
}

// Node type definitions
export type NodeType = 'start' | 'trigger' | 'condition' | 'action' | 'control' | 'logic_gate' | 'end';

export type TriggerType = 'time' | 'webhook' | 'variable_monitor' | 'task_status' | 'system_event';
export type ConditionOperator = 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'not_contains';
export type ActionType = 'run_task' | 'set_variable' | 'execute_command' | 'send_notification';
export type ControlType = 'delay' | 'retry' | 'circuit_breaker';
export type LogicGateType = 'AND' | 'OR';

// Node data interfaces
export interface StartNodeData extends FlowgramNodeData {
  label: string;
}

export interface TriggerNodeData extends FlowgramNodeData {
  triggerType: TriggerType;
  config?: any;
}

export interface ConditionNodeData extends FlowgramNodeData {
  operator: ConditionOperator;
  field: string;
  value: any;
}

export interface ActionNodeData extends FlowgramNodeData {
  actionType: ActionType;
  cronId?: number;
  name?: string;
  value?: string;
  command?: string;
  message?: string;
}

export interface ControlNodeData extends FlowgramNodeData {
  controlType: ControlType;
  delaySeconds?: number;
  maxRetries?: number;
  retryDelay?: number;
  backoffMultiplier?: number;
  failureThreshold?: number;
}

export interface LogicGateNodeData extends FlowgramNodeData {
  gateType: LogicGateType;
}

export interface EndNodeData extends FlowgramNodeData {
  label: string;
}
