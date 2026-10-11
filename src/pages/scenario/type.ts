export type NodeType = 'http' | 'script' | 'condition' | 'delay' | 'loop';

export interface WorkflowNode {
  id: string;
  type: string;
  data?: Record<string, any>;
  blocks?: WorkflowNode[];
  [key: string]: any;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  [key: string]: any;
}

export interface Scenario {
  id?: number;
  name: string;
  description?: string;
  status?: 0 | 1; // 0: disabled, 1: enabled
  workflowGraph?: WorkflowGraph;
  createdAt?: Date;
  updatedAt?: Date;
}
