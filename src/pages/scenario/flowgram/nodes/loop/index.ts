import { nanoid } from 'nanoid';

import { FlowNodeRegistry } from '../../typings';
import iconLoop from '../../assets/icon-loop.svg';
import { formMeta } from './form-meta';

export const LoopNodeRegistry: FlowNodeRegistry = {
  type: 'loop',
  info: {
    icon: iconLoop,
    description:
      'Used to repeatedly execute a series of tasks by setting the number of iterations and logic',
  },
  meta: {
    expandable: false, // disable expanded
  },
  formMeta,
  onAdd() {
    return {
      id: `loop_${nanoid(5)}`,
      type: 'loop',
      data: {
        title: 'Loop',
      },
    };
  },
};
