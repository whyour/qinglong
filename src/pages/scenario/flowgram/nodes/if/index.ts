import { nanoid } from 'nanoid';
import { FlowNodeSplitType } from '@flowgram.ai/fixed-layout-editor';

import { defaultFormMeta } from '../default-form-meta';
import { FlowNodeRegistry } from '../../typings';
import iconIf from '../../assets/icon-if.png';

export const IFNodeRegistry: FlowNodeRegistry = {
  extend: FlowNodeSplitType.STATIC_SPLIT,
  type: 'if',
  info: {
    icon: iconIf,
    description: 'Only the corresponding branch will be executed if the set conditions are met.',
  },
  meta: {
    expandable: false, // disable expanded
  },
  formMeta: defaultFormMeta,
  onAdd() {
    return {
      id: `if_${nanoid(5)}`,
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
          id: nanoid(5),
          type: 'ifBlock',
          data: {
            title: 'true',
          },
          blocks: [],
        },
        {
          id: nanoid(5),
          type: 'ifBlock',
          data: {
            title: 'false',
          },
        },
      ],
    };
  },
};
