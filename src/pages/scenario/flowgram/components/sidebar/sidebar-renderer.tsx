import { useCallback, useEffect, startTransition } from 'react';

import { type PanelFactory, usePanelManager } from '@flowgram.ai/panel-manager-plugin';
import {
  PlaygroundEntityContext,
  useRefresh,
  useClientContext,
} from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeMeta } from '../../typings';
import { IsSidebarContext } from '../../context';
import { SidebarNodeRenderer } from './sidebar-node-renderer';

export interface NodeFormPanelProps {
  nodeId: string;
}

export const SidebarRenderer: React.FC<NodeFormPanelProps> = ({ nodeId }) => {
  const panelManager = usePanelManager();
  const { selection, playground, document } = useClientContext();
  const refresh = useRefresh();
  const handleClose = useCallback(() => {
    // Sidebar delayed closing
    startTransition(() => {
      panelManager.close(nodeFormPanelFactory.key);
    });
  }, []);
  const node = nodeId ? document.getNode(nodeId) : undefined;
  /**
   * Listen readonly
   */
  useEffect(() => {
    const disposable = playground.config.onReadonlyOrDisabledChange(() => {
      handleClose();
      refresh();
    });
    return () => disposable.dispose();
  }, [playground]);
  /**
   * Listen selection
   */
  useEffect(() => {
    const toDispose = selection.onSelectionChanged(() => {
      /**
       * 如果没有选中任何节点，则自动关闭侧边栏
       * If no node is selected, the sidebar is automatically closed
       */
      if (selection.selection.length === 0) {
        handleClose();
      } else if (selection.selection.length === 1 && selection.selection[0] !== node) {
        handleClose();
      }
    });
    return () => toDispose.dispose();
  }, [selection, handleClose, node]);
  /**
   * Close when node disposed
   */
  useEffect(() => {
    if (node) {
      const toDispose = node.onDispose(() => {
        panelManager.close(nodeFormPanelFactory.key);
      });
      return () => toDispose.dispose();
    }
    return () => {};
  }, [node]);

  if (!node || node.getNodeMeta<FlowNodeMeta>().sidebarDisabled === true) {
    return null;
  }

  if (playground.config.readonly) {
    return null;
  }

  return (
    <IsSidebarContext.Provider value={true}>
      <PlaygroundEntityContext.Provider key={node.id} value={node}>
        <SidebarNodeRenderer node={node} />
      </PlaygroundEntityContext.Provider>
    </IsSidebarContext.Provider>
  );
};

export const nodeFormPanelFactory: PanelFactory<NodeFormPanelProps> = {
  key: 'node-form-panel',
  defaultSize: 400,
  render: (props: NodeFormPanelProps) => <SidebarRenderer {...props} />,
};
