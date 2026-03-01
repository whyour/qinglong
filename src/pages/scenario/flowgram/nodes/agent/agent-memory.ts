import { FlowNodeBaseType } from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeRegistry } from '../../typings';

export const AgentMemoryNodeRegistry: FlowNodeRegistry = {
  type: 'agentMemory',
  extend: FlowNodeBaseType.SLOT_BLOCK,
  meta: {
    addDisable: true,
    sidebarDisable: true,
  },
  info: {
    icon: '',
    description: 'Agent Memory.',
  },
};
