import { type FlowNodeEntity } from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeRegistry } from '../../typings';
import { Icon } from './styles';

export const getIcon = (node: FlowNodeEntity) => {
  const icon = node.getNodeRegistry<FlowNodeRegistry>().info?.icon;
  if (!icon) return null;
  return <Icon src={icon} />;
};
