import { nanoid } from 'nanoid';

import { defaultFormMeta } from '../default-form-meta';
import { FlowNodeRegistry } from '../../typings';
import iconMemory from '../../assets/icon-memory.svg';

let index = 0;
export const MemoryNodeRegistry: FlowNodeRegistry = {
  type: 'memory',
  info: {
    icon: iconMemory,
    description: 'Memory.',
  },
  meta: {
    addDisable: true,
    // deleteDisable: true, // memory 不能单独删除，只能通过 agent
    copyDisable: true,
    draggable: false,
    selectable: false,
  },
  formMeta: defaultFormMeta,
  onAdd() {
    return {
      id: `memory_${nanoid(5)}`,
      type: 'memory',
      data: {
        title: `Memory_${++index}`,
      },
    };
  },
};
