import { useNodeRender, FlowNodeEntity } from '@flowgram.ai/fixed-layout-editor';

import { NodeRenderContext } from '../../context';

export function SidebarNodeRenderer(props: { node: FlowNodeEntity }) {
  const { node } = props;
  const nodeRender = useNodeRender(node);

  return (
    <NodeRenderContext.Provider value={nodeRender}>
      <div
        style={{
          background: 'rgb(251, 251, 251)',
          height: '100%',
          borderRadius: 8,
          border: '1px solid rgba(82,100,154, 0.13)',
          boxSizing: 'border-box',
        }}
      >
        {nodeRender.form?.render()}
      </div>
    </NodeRenderContext.Provider>
  );
}
