import { nanoid } from 'nanoid';
import { WorkflowNodeType } from '../constants';
import intl from 'react-intl-universal';
import { FlowNodeRegistry } from '../http';

let loopIndex = 0;

export const LoopNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.LOOP,
  info: {
    description: intl.get('循环'),
  },
  meta: {
    size: {
      width: 280,
      height: 100,
    },
  },
  onAdd() {
    return {
      id: `loop_${nanoid(5)}`,
      type: WorkflowNodeType.LOOP,
      data: {
        title: `${intl.get('循环')} ${++loopIndex}`,
        iterations: 5,
      },
    };
  },
};
