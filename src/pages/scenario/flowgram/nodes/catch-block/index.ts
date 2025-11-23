import { nanoid } from 'nanoid';

import { FlowNodeRegistry } from '../../typings';
import iconCase from '../../assets/icon-case.png';
import { formMeta } from './form-meta';

let id = 3;
export const CatchBlockNodeRegistry: FlowNodeRegistry = {
  type: 'catchBlock',
  meta: {
    copyDisable: true,
    addDisable: true,
  },
  info: {
    icon: iconCase,
    description: 'Execute the catch branch when the condition is met.',
  },
  canAdd: () => false,
  canDelete: (ctx, node) => node.parent!.blocks.length >= 2,
  onAdd(ctx, from) {
    return {
      id: `Catch_${nanoid(5)}`,
      type: 'catchBlock',
      data: {
        title: `Catch Block ${id++}`,
        inputs: {
          type: 'object',
          required: ['condition'],
          inputsValues: {
            condition: '',
          },
          properties: {
            condition: {
              type: 'string',
            },
          },
        },
      },
    };
  },
  formMeta,
};
