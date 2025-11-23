import { nanoid } from 'nanoid';
import { WorkflowNodeType } from '../constants';
import intl from 'react-intl-universal';
import { FlowNodeRegistry } from '../http';

let conditionIndex = 0;

export const ConditionNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.CONDITION,
  info: {
    description: intl.get('条件判断'),
  },
  meta: {
    size: {
      width: 280,
      height: 120,
    },
  },
  onAdd() {
    return {
      id: `condition_${nanoid(5)}`,
      type: WorkflowNodeType.CONDITION,
      data: {
        title: `${intl.get('条件判断')} ${++conditionIndex}`,
        condition: '',
      },
    };
  },
};
