import { useCallback } from 'react';

import { usePanelManager } from '@flowgram.ai/panel-manager-plugin';
import { FlowNodeEntity, useNodeRender } from '@flowgram.ai/fixed-layout-editor';
import { ConfigProvider } from 'antd';

import { NodeRenderContext } from '../../context';
import { BaseNodeStyle, ErrorIcon } from './styles';
import { nodeFormPanelFactory } from '../sidebar';

export const BaseNode = ({ node }: { node: FlowNodeEntity }) => {
  /**
   * Provides methods related to node rendering
   * 提供节点渲染相关的方法
   */
  const nodeRender = useNodeRender();
  /**
   * It can only be used when nodeEngine is enabled
   * 只有在节点引擎开启时候才能使用表单
   */
  const form = nodeRender.form;

  /**
   * Used to make the Tooltip scale with the node, which can be implemented by itself depending on the UI library
   * 用于让 Tooltip 跟随节点缩放, 这个可以根据不同的 ui 库自己实现
   */
  const getPopupContainer = useCallback(() => node.renderData.node || document.body, []);

  const panelManager = usePanelManager();

  return (
    <ConfigProvider getPopupContainer={getPopupContainer}>
      {form?.state.invalid && <ErrorIcon />}
      <BaseNodeStyle
        /*
         * onMouseEnter is added to a fixed layout node primarily to listen for hover highlighting of branch lines
         * onMouseEnter 加到固定布局节点主要是为了监听 分支线条的 hover 高亮
         **/
        onMouseEnter={nodeRender.onMouseEnter}
        onMouseLeave={nodeRender.onMouseLeave}
        className={nodeRender.activated ? 'activated' : ''}
        onClick={() => {
          if (nodeRender.dragging) {
            return;
          }
          panelManager.open(nodeFormPanelFactory.key, 'right', {
            props: {
              nodeId: nodeRender.node.id,
            },
          });
        }}
        style={{
          /**
           * Lets you precisely control the style of branch nodes
           * 用于精确控制分支节点的样式
           * isBlockIcon: 整个 condition 分支的 头部节点
           * isBlockOrderIcon: 分支的第一个节点
           */
          ...(nodeRender.isBlockOrderIcon || nodeRender.isBlockIcon ? {} : {}),
          ...nodeRender.node.getNodeRegistry().meta.style,
          opacity: nodeRender.dragging ? 0.3 : 1,
          outline: form?.state.invalid ? '1px solid red' : 'none',
        }}
      >
        <NodeRenderContext.Provider value={nodeRender}>{form?.render()}</NodeRenderContext.Provider>
      </BaseNodeStyle>
    </ConfigProvider>
  );
};
