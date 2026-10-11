import { nanoid } from 'nanoid';
import { FlowNodeBaseType } from '@flowgram.ai/fixed-layout-editor';

import { LLMNodeRegistry } from '../llm';
import { defaultFormMeta } from '../default-form-meta';
import { FlowNodeRegistry } from '../../typings';
import iconRobot from '../../assets/icon-robot.svg';
import { ToolNodeRegistry } from './tool';
import { MemoryNodeRegistry } from './memory';

let index = 0;
export const AgentNodeRegistry: FlowNodeRegistry = {
  type: 'agent',
  extend: FlowNodeBaseType.SLOT,
  info: {
    icon: iconRobot,
    description: 'AI Agent.',
  },
  formMeta: defaultFormMeta,
  onAdd(ctx, from) {
    return {
      id: `agent_${nanoid(5)}`,
      type: 'agent',
      blocks: [
        {
          id: `agentLLM_${nanoid(5)}`,
          type: 'agentLLM',
          blocks: [LLMNodeRegistry.onAdd!(ctx, from)],
        },
        {
          id: `agentMemory_${nanoid(5)}`,
          type: 'agentMemory',
          blocks: [MemoryNodeRegistry.onAdd!(ctx, from)],
        },
        {
          id: `agentTools_${nanoid(5)}`,
          type: 'agentTools',
          blocks: [ToolNodeRegistry.onAdd!(ctx, from)],
        },
      ],
      data: {
        title: `Agent_${++index}`,
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
