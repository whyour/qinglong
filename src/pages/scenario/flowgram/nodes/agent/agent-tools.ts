import { nanoid } from 'nanoid';
import { FlowNodeBaseType } from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeRegistry } from '../../typings';

let index = 0;
export const AgentToolsNodeRegistry: FlowNodeRegistry = {
  type: 'agentTools',
  extend: FlowNodeBaseType.SLOT_BLOCK,
  info: {
    icon: '',
    description: 'Agent Tools.',
  },
  meta: {
    addDisable: true,
    sidebarDisable: true,
  },
  onAdd() {
    return {
      id: `tool_${nanoid(5)}`,
      type: 'agentTool',
      data: {
        title: `Tool_${++index}`,
        outputs: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
        },
      },
    };
  },
};
