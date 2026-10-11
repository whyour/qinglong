import { nanoid } from 'nanoid';

import { defaultFormMeta } from '../default-form-meta';
import { AgentLLMNodeRegistry } from '../agent/agent-llm';
import { FlowNodeRegistry } from '../../typings';
import iconLLM from '../../assets/icon-llm.jpg';

let index = 0;
export const LLMNodeRegistry: FlowNodeRegistry = {
  type: 'llm',
  info: {
    icon: iconLLM,
    description:
      'Call the large language model and use variables and prompt words to generate responses.',
  },
  formMeta: defaultFormMeta,
  meta: {
    draggable: (node) => node.parent?.flowNodeType !== AgentLLMNodeRegistry.type,
  },
  canDelete(ctx, node) {
    return node.parent?.flowNodeType !== AgentLLMNodeRegistry.type;
  },
  onAdd() {
    return {
      id: `llm_${nanoid(5)}`,
      type: 'llm',
      data: {
        title: `LLM_${++index}`,
        inputsValues: {
          modelType: {
            type: 'constant',
            content: 'gpt-3.5-turbo',
          },
          temperature: {
            type: 'constant',
            content: 0.5,
          },
          systemPrompt: {
            type: 'template',
            content: '# Role\nYou are an AI assistant.\n',
          },
          prompt: {
            type: 'template',
            content: '',
          },
        },
        inputs: {
          type: 'object',
          required: ['modelType', 'temperature', 'prompt'],
          properties: {
            modelType: {
              type: 'string',
            },
            temperature: {
              type: 'number',
            },
            systemPrompt: {
              type: 'string',
              extra: { formComponent: 'prompt-editor' },
            },
            prompt: {
              type: 'string',
              extra: { formComponent: 'prompt-editor' },
            },
          },
        },
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
