import { nanoid } from 'nanoid';
import { WorkflowNodeType } from '../constants';
import intl from 'react-intl-universal';
import { FlowNodeRegistry } from '../http';

export const EndNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.END,
  info: {
    description: intl.get('结束'),
  },
  meta: {
    size: {
      width: 120,
      height: 60,
    },
  },
  onAdd() {
    return {
      id: `end_${nanoid(5)}`,
      type: WorkflowNodeType.END,
      data: {
        title: intl.get('结束'),
      },
    };
  },
};
