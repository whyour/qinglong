import { FlowNodeBaseType } from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeRegistry } from '../../typings';

export const AgentLLMNodeRegistry: FlowNodeRegistry = {
  type: 'agentLLM',
  extend: FlowNodeBaseType.SLOT_BLOCK,
  meta: {
    addDisable: true,
    sidebarDisable: true,
    draggable: false,
  },
  info: {
    icon: '',
    description: 'Agent LLM.',
  },
};
