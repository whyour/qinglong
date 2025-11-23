import { nanoid } from 'nanoid';
import { WorkflowNodeType } from '../constants';
import intl from 'react-intl-universal';
import { FlowNodeRegistry } from '../http';

export const StartNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.START,
  info: {
    description: intl.get('开始'),
  },
  meta: {
    size: {
      width: 120,
      height: 60,
    },
  },
  onAdd() {
    return {
      id: `start_${nanoid(5)}`,
      type: WorkflowNodeType.START,
      data: {
        title: intl.get('开始'),
      },
    };
  },
};
