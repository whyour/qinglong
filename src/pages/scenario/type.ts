export type NodeType = 'http' | 'script' | 'condition' | 'delay' | 'loop';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  x?: number;
  y?: number;
  config: {
    // HTTP Request node
    url?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    headers?: Record<string, string>;
    body?: string;

    // Script node
    scriptId?: number;
    scriptPath?: string;
    scriptContent?: string;

    // Condition node
    condition?: string;
    trueNext?: string;
    falseNext?: string;

    // Delay node
    delayMs?: number;

    // Loop node
    iterations?: number;
    loopBody?: string[];
  };
  next?: string | string[]; // ID(s) of next node(s)
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  startNode?: string;
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
