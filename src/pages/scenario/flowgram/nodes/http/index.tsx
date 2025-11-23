import { nanoid } from 'nanoid';
import { WorkflowNodeType } from '../constants';
import intl from 'react-intl-universal';

export interface FlowNodeRegistry {
  type: string;
  info: {
    icon?: string;
    description?: string;
  };
  meta?: {
    size?: {
      width: number;
      height: number;
    };
  };
  onAdd: () => any;
  formMeta?: any;
}

let httpIndex = 0;

export const HTTPNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.HTTP,
  info: {
    description: intl.get('HTTP请求'),
  },
  meta: {
    size: {
      width: 280,
      height: 120,
    },
  },
  onAdd() {
    return {
      id: `http_${nanoid(5)}`,
      type: WorkflowNodeType.HTTP,
      data: {
        title: `${intl.get('HTTP请求')} ${++httpIndex}`,
        url: '',
        method: 'GET',
        headers: {},
        body: '',
      },
    };
  },
};
