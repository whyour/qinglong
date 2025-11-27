import { FlowDocumentJSON } from './typings';

export const initialData: FlowDocumentJSON = {
  nodes: [
    {
      id: 'start_0',
      type: 'start',
      blocks: [],
      data: {
        title: 'Start',
        outputs: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              default: 'Hello Flow.',
            },
            enable: {
              type: 'boolean',
              default: true,
            },
            array_obj: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  int: {
                    type: 'number',
                  },
                  str: {
                    type: 'string',
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      id: 'agent_0',
      type: 'agent',
      data: {
        title: 'Agent',
      },
      blocks: [
        {
          id: 'agentLLM_0',
          type: 'agentLLM',
          blocks: [
            {
              id: 'llm_5',
              type: 'llm',
              meta: {
                defaultExpanded: false,
              },
              data: {
                title: 'LLM',
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
            },
          ],
        },
        {
          id: 'agentMemory_0',
          type: 'agentMemory',
          blocks: [
            {
              id: 'memory_0',
              type: 'memory',
              meta: {
                defaultExpanded: false,
              },
              data: {
                title: 'Memory',
              },
            },
          ],
        },
        {
          id: 'agentTools_0',
          type: 'agentTools',
          blocks: [
            {
              id: 'tool_0',
              type: 'tool',
              data: {
                title: 'Tool0',
              },
            },
            {
              id: 'tool_1',
              type: 'tool',
              data: {
                title: 'Tool1',
              },
            },
          ],
        },
      ],
    },
    {
      id: 'llm_0',
      type: 'llm',
      blocks: [],
      data: {
        title: 'LLM',
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
    },
    {
      id: 'switch_0',
      type: 'switch',
      data: {
        title: 'Switch',
      },
      blocks: [
        {
          id: 'case_0',
          type: 'case',
          data: {
            title: 'Case_0',
            inputsValues: {
              condition: { type: 'constant', content: true },
            },
            inputs: {
              type: 'object',
              required: ['condition'],
              properties: {
                condition: {
                  type: 'boolean',
                },
              },
            },
          },
          blocks: [],
        },
        {
          id: 'case_1',
          type: 'case',
          data: {
            title: 'Case_1',
            inputsValues: {
              condition: { type: 'constant', content: true },
            },
            inputs: {
              type: 'object',
              required: ['condition'],
              properties: {
                condition: {
                  type: 'boolean',
                },
              },
            },
          },
        },
        {
          id: 'case_default_1',
          type: 'caseDefault',
          data: {
            title: 'Default',
          },
          blocks: [],
        },
      ],
    },
    {
      id: 'loop_0',
      type: 'loop',
      data: {
        title: 'Loop',
        loopFor: {
          type: 'ref',
          content: ['start_0', 'array_obj'],
        },
      },
      blocks: [
        {
          id: 'if_0',
          type: 'if',
          data: {
            title: 'If',
            inputsValues: {
              condition: { type: 'constant', content: true },
            },
            inputs: {
              type: 'object',
              required: ['condition'],
              properties: {
                condition: {
                  type: 'boolean',
                },
              },
            },
          },
          blocks: [
            {
              id: 'if_true',
              type: 'ifBlock',
              data: {
                title: 'true',
              },
              blocks: [],
            },
            {
              id: 'if_false',
              type: 'ifBlock',
              data: {
                title: 'false',
              },
              blocks: [
                {
                  id: 'break_0',
                  type: 'breakLoop',
                  data: {
                    title: 'BreakLoop',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'tryCatch_0',
      type: 'tryCatch',
      data: {
        title: 'TryCatch',
      },
      blocks: [
        {
          id: 'tryBlock_0',
          type: 'tryBlock',
          blocks: [],
        },
        {
          id: 'catchBlock_0',
          type: 'catchBlock',
          data: {
            title: 'Catch Block 1',
            inputsValues: {
              condition: { type: 'constant', content: true },
            },
            inputs: {
              type: 'object',
              required: ['condition'],
              properties: {
                condition: {
                  type: 'boolean',
                },
              },
            },
          },
          blocks: [],
        },
        {
          id: 'catchBlock_1',
          type: 'catchBlock',
          data: {
            title: 'Catch Block 2',
            inputsValues: {
              condition: { type: 'constant', content: true },
            },
            inputs: {
              type: 'object',
              required: ['condition'],
              properties: {
                condition: {
                  type: 'boolean',
                },
              },
            },
          },
          blocks: [],
        },
      ],
    },
    {
      id: 'end_0',
      type: 'end',
      blocks: [],
      data: {
        title: 'End',
        inputsValues: {
          success: { type: 'constant', content: true, schema: { type: 'boolean' } },
        },
      },
    },
  ],
};
