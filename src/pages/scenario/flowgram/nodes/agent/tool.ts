import { nanoid } from 'nanoid';

import { defaultFormMeta } from '../default-form-meta';
import { FlowNodeRegistry } from '../../typings';
import iconTool from '../../assets/icon-tool.svg';

let index = 0;
export const ToolNodeRegistry: FlowNodeRegistry = {
  type: 'tool',
  info: {
    icon: iconTool,
    description: 'Tool.',
  },
  meta: {
    // addDisable: true,
    copyDisable: true,
    draggable: false,
    selectable: false,
  },
  formMeta: defaultFormMeta,
  onAdd() {
    return {
      id: `tool${nanoid(5)}`,
      type: 'tool',
      data: {
        title: `Tool_${++index}`,
      },
    };
  },
};
