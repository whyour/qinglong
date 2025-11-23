import { nanoid } from 'nanoid';
import { WorkflowNodeType } from '../constants';
import intl from 'react-intl-universal';
import { FlowNodeRegistry } from '../http';

let delayIndex = 0;

export const DelayNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.DELAY,
  info: {
    description: intl.get('延迟'),
  },
  meta: {
    size: {
      width: 280,
      height: 100,
    },
  },
  onAdd() {
    return {
      id: `delay_${nanoid(5)}`,
      type: WorkflowNodeType.DELAY,
      data: {
        title: `${intl.get('延迟')} ${++delayIndex}`,
        delayMs: 1000,
      },
    };
  },
};
