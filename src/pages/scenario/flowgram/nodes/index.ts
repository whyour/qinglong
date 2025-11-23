export * from './constants';
export { HTTPNodeRegistry } from './http';
export { ScriptNodeRegistry } from './script';
export { ConditionNodeRegistry } from './condition';
export { DelayNodeRegistry } from './delay';
export { LoopNodeRegistry } from './loop';
export { StartNodeRegistry } from './start';
export { EndNodeRegistry } from './end';

import { HTTPNodeRegistry } from './http';
import { ScriptNodeRegistry } from './script';
import { ConditionNodeRegistry } from './condition';
import { DelayNodeRegistry } from './delay';
import { LoopNodeRegistry } from './loop';
import { StartNodeRegistry } from './start';
import { EndNodeRegistry } from './end';

export const nodeRegistries = [
  StartNodeRegistry,
  HTTPNodeRegistry,
  ScriptNodeRegistry,
  ConditionNodeRegistry,
  DelayNodeRegistry,
  LoopNodeRegistry,
  EndNodeRegistry,
];
