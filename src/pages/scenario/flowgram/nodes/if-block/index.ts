import { FlowNodeRegistry } from '../../typings';
import iconIf from '../../assets/icon-if.png';
import { formMeta } from './form-meta';

export const IFBlockNodeRegistry: FlowNodeRegistry = {
  type: 'ifBlock',
  /**
   * 分支节点需要继承自 block
   * Branch nodes need to inherit from 'block'
   */
  extend: 'block',
  meta: {
    copyDisable: true,
    addDisable: true,
    sidebarDisable: true,
    defaultExpanded: false,
    style: {
      width: 66,
      height: 20,
      borderRadius: 4,
    },
  },
  info: {
    icon: iconIf,
    description: '',
  },
  canAdd: () => false,
  canDelete: (ctx, node) => false,
  formMeta,
};
