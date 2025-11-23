import { nanoid } from 'nanoid';

import { FlowNodeRegistry } from '../../typings';
import iconTryCatch from '../../assets/icon-trycatch.svg';
import { formMeta } from './form-meta';

export const TryCatchNodeRegistry: FlowNodeRegistry = {
  type: 'tryCatch',
  info: {
    icon: iconTryCatch,
    description: 'try catch.',
  },
  meta: {
    expandable: false, // disable expanded
  },
  formMeta,
  onAdd() {
    return {
      id: `tryCatch${nanoid(5)}`,
      type: 'tryCatch',
      data: {
        title: 'TryCatch',
      },
      blocks: [
        {
          id: `tryBlock${nanoid(5)}`,
          type: 'tryBlock',
          blocks: [],
        },
        {
          id: `catchBlock${nanoid(5)}`,
          type: 'catchBlock',
          blocks: [],
          data: {
            title: 'Catch Block 1',
            inputsValues: {
              condition: '',
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
      ],
    };
  },
};
