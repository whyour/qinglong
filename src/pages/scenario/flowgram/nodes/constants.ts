/**
 * Workflow node types
 */
export enum WorkflowNodeType {
  START = 'start',
  END = 'end',
  HTTP = 'http',
  SCRIPT = 'script',
  CONDITION = 'condition',
  DELAY = 'delay',
  LOOP = 'loop',
}
