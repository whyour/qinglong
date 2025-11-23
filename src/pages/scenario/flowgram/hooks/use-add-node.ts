/**
 * Hook for adding new workflow nodes
 * Following Flowgram demo pattern from:
 * https://github.com/bytedance/flowgram.ai/blob/main/apps/demo-free-layout/src/components/add-node/use-add-node.ts
 */
import { useCallback } from 'react';
import {
  useService,
  WorkflowDocument,
  usePlayground,
  PositionSchema,
  WorkflowNodeEntity,
  WorkflowSelectService,
  getAntiOverlapPosition,
  WorkflowNodeMeta,
  FlowNodeBaseType,
} from '@flowgram.ai/free-layout-editor';
import { NodePanelResult, WorkflowNodePanelService } from '@flowgram.ai/free-node-panel-plugin';

// Hook to get panel position from mouse event
const useGetPanelPosition = () => {
  const playground = usePlayground();
  return useCallback(
    (targetBoundingRect: DOMRect): PositionSchema =>
      playground.config.getPosFromMouseEvent({
        clientX: targetBoundingRect.left + 64,
        clientY: targetBoundingRect.top - 7,
      }),
    [playground]
  );
};

// Hook to handle node selection
const useSelectNode = () => {
  const selectService = useService(WorkflowSelectService);
  return useCallback(
    (node?: WorkflowNodeEntity) => {
      if (!node) {
        return;
      }
      selectService.selectNode(node);
    },
    [selectService]
  );
};

const getContainerNode = (selectService: WorkflowSelectService) => {
  const { activatedNode } = selectService;
  if (!activatedNode) {
    return;
  }
  const { isContainer } = activatedNode.getNodeMeta<WorkflowNodeMeta>();
  if (isContainer) {
    return activatedNode;
  }
  const parentNode = activatedNode.parent;
  if (!parentNode || parentNode.flowNodeType === FlowNodeBaseType.ROOT) {
    return;
  }
  return parentNode;
};

// Main hook for adding new nodes
export const useAddNode = () => {
  const workflowDocument = useService(WorkflowDocument);
  const nodePanelService = useService<WorkflowNodePanelService>(WorkflowNodePanelService);
  const selectService = useService(WorkflowSelectService);
  const playground = usePlayground();
  const getPanelPosition = useGetPanelPosition();
  const select = useSelectNode();

  return useCallback(
    async (targetBoundingRect: DOMRect): Promise<void> => {
      const panelPosition = getPanelPosition(targetBoundingRect);
      const containerNode = getContainerNode(selectService);
      
      await new Promise<void>((resolve) => {
        nodePanelService.callNodePanel({
          position: panelPosition,
          enableMultiAdd: true,
          containerNode,
          panelProps: {},
          onSelect: async (panelParams?: NodePanelResult) => {
            if (!panelParams) {
              return;
            }
            const { nodeType, nodeJSON } = panelParams;
            const position = Boolean(containerNode)
              ? getAntiOverlapPosition(workflowDocument, {
                  x: 0,
                  y: 200,
                })
              : undefined;
            
            const node: WorkflowNodeEntity = workflowDocument.createWorkflowNodeByType(
              nodeType,
              position,
              containerNode?.id,
              nodeJSON
            );
            
            select(node);
            resolve();
          },
        });
      });
    },
    [workflowDocument, nodePanelService, selectService, playground, getPanelPosition, select]
  );
};
