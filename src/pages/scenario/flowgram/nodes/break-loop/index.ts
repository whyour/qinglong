import { nanoid } from 'nanoid';

import { FlowNodeRegistry } from '../../typings';
import iconBreak from '../../assets/icon-break.svg';
import { formMeta } from './form-meta';

/**
 * Break 节点用于在 loop 中根据条件终止并跳出
 */
export const BreakLoopNodeRegistry: FlowNodeRegistry = {
  type: 'breakLoop',
  extend: 'end',
  info: {
    icon: iconBreak,
    description: 'Break in current Loop.',
  },
  meta: {
    style: {
      width: 240,
    },
  },
  /**
   * Render node via formMeta
   */
  formMeta,
  canAdd(ctx, from) {
    while (from.parent) {
      if (from.parent.flowNodeType === 'loop') return true;
      from = from.parent;
    }
    return false;
  },
  onAdd(ctx, from) {
    return {
      id: `break_${nanoid()}`,
      type: 'breakLoop',
      data: {
        title: 'BreakLoop',
      },
    };
  },
};
