import { FlowNodeRegistry } from '../../typings';
import iconStart from '../../assets/icon-start.jpg';
import { formMeta } from './form-meta';

export const StartNodeRegistry: FlowNodeRegistry = {
  type: 'start',
  meta: {
    isStart: true, // Mark as start
    deleteDisable: true, // Start node cannot delete
    selectable: false, // Start node cannot select
    copyDisable: true, // Start node cannot copy
    expandable: false, // disable expanded
    addDisable: true, // Start Node cannot be added
  },
  info: {
    icon: iconStart,
    description:
      'The starting node of the workflow, used to set the information needed to initiate the workflow.',
  },
  /**
   * Render node via formMeta
   */
  formMeta,
};
