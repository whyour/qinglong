import {
  type FlowNodeEntity,
  FlowNodeRenderData,
  useClientContext,
} from '@flowgram.ai/fixed-layout-editor';

import { ToolNodeRegistry } from '../../nodes/agent/tool';
import { PlusOutlined } from '@ant-design/icons';

interface PropsType {
  node: FlowNodeEntity;
}

export function AgentAdder(props: PropsType) {
  const { node } = props;

  const nodeData = node.firstChild?.getData<FlowNodeRenderData>(FlowNodeRenderData);
  const ctx = useClientContext();

  async function addPort() {
    ctx.operation.addNode(ToolNodeRegistry.onAdd!(ctx, node), {
      parent: node,
    });
  }

  /**
   * 1. Tools can always be added
   * 2. LLM/Memory can only be added when there is no block
   */
  const canAdd = node.flowNodeType === 'agentTools' || node.blocks.length === 0;

  if (!canAdd) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        color: '#fff',
        background: 'rgb(187, 191, 196)',
        width: 20,
        height: 20,
        borderRadius: 10,
        overflow: 'hidden',
      }}
      onMouseEnter={() => nodeData?.toggleMouseEnter()}
      onMouseLeave={() => nodeData?.toggleMouseLeave()}
    >
      <div
        style={{
          width: 20,
          height: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
        onClick={() => addPort()}
      >
        <PlusOutlined />
      </div>
    </div>
  );
}
