import { nanoid } from 'nanoid';
import { WorkflowNodeType } from '../constants';
import intl from 'react-intl-universal';
import { FlowNodeRegistry } from '../http';

let scriptIndex = 0;

export const ScriptNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.SCRIPT,
  info: {
    description: intl.get('脚本执行'),
  },
  meta: {
    size: {
      width: 280,
      height: 120,
    },
  },
  onAdd() {
    return {
      id: `script_${nanoid(5)}`,
      type: WorkflowNodeType.SCRIPT,
      data: {
        title: `${intl.get('脚本执行')} ${++scriptIndex}`,
        scriptPath: '',
        scriptContent: '',
      },
    };
  },
};
