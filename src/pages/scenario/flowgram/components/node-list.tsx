import styled from 'styled-components';
import {
  FlowNodeEntity,
  FlowNodeRegistry,
  useClientContext,
} from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeRegistries } from '../nodes';

const NodeWrap = styled.div`
  width: 100%;
  height: 32px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 19px;
  padding: 0 15px;
  &:hover {
    background-color: hsl(252deg 62% 55% / 9%);
    color: hsl(252 62% 54.9%);
  },
`;

const NodeLabel = styled.div`
  font-size: 12px;
  margin-left: 10px;
`;

function Node(props: { label: string; icon: JSX.Element; onClick: () => void; disabled: boolean }) {
  return (
    <NodeWrap
      onClick={props.disabled ? undefined : props.onClick}
      style={props.disabled ? { opacity: 0.3 } : {}}
    >
      <div style={{ fontSize: 14 }}>{props.icon}</div>
      <NodeLabel>{props.label}</NodeLabel>
    </NodeWrap>
  );
}

const NodesWrap = styled.div`
  max-height: 500px;
  overflow: auto;
  &::-webkit-scrollbar {
    display: none;
  }
`;

export function NodeList(props: { onSelect: (meta: any) => void; from: FlowNodeEntity }) {
  const context = useClientContext();
  const handleClick = (registry: FlowNodeRegistry) => {
    const addProps = registry.onAdd(context, props.from);
    props.onSelect?.(addProps);
  };
  return (
    <NodesWrap style={{ width: 80 * 2 + 20 }}>
      {FlowNodeRegistries.filter((registry) => !registry.meta?.addDisable).map((registry) => (
        <Node
          key={registry.type}
          disabled={!(registry.canAdd?.(context, props.from) ?? true)}
          icon={<img style={{ width: 10, height: 10, borderRadius: 4 }} src={registry.info.icon} />}
          label={registry.type as string}
          onClick={() => handleClick(registry)}
        />
      ))}
    </NodesWrap>
  );
}
