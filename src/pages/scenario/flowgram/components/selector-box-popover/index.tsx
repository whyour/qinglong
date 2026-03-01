import { FunctionComponent, useMemo } from 'react';

import {
  useStartDragNode,
  FlowNodeRenderData,
  FlowNodeBaseType,
  FlowGroupService,
  type FlowNodeEntity,
  SelectorBoxPopoverProps,
} from '@flowgram.ai/fixed-layout-editor';
import { Button, Tooltip } from 'antd';

import { FlowCommandId } from '../../shortcuts/constants';
import { IconGroupOutlined } from '../../plugins/group-plugin/icons';
import { CopyOutlined, DeleteOutlined, DragOutlined, ExpandOutlined, ShrinkOutlined } from '@ant-design/icons';

const BUTTON_HEIGHT = 24;

export const SelectorBoxPopover: FunctionComponent<SelectorBoxPopoverProps> = ({
  bounds,
  children,
  flowSelectConfig,
  commandRegistry,
}) => {
  const selectNodes = flowSelectConfig.selectedNodes;

  const { startDrag } = useStartDragNode();

  const draggable = selectNodes[0]?.getData(FlowNodeRenderData)?.draggable;

  // Does the selected component have a group node? (High-cost computation must use memo)
  const hasGroup: boolean = useMemo(() => {
    if (!selectNodes || selectNodes.length === 0) {
      return false;
    }
    const findGroupInNodes = (nodes: FlowNodeEntity[]): boolean =>
      nodes.some((node) => {
        if (node.flowNodeType === FlowNodeBaseType.GROUP) {
          return true;
        }
        if (node.blocks && node.blocks.length) {
          return findGroupInNodes(node.blocks);
        }
        return false;
      });
    return findGroupInNodes(selectNodes);
  }, [selectNodes]);

  const canGroup = !hasGroup && FlowGroupService.validate(selectNodes);

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: bounds.right,
          top: bounds.top,
          transform: 'translate(-100%, -100%)',
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
      >
        <Button.Group
          size="small"
          style={{ display: 'flex', flexWrap: 'nowrap', height: BUTTON_HEIGHT }}
        >
          {draggable && (
            <Tooltip title="Drag">
              <Button
                style={{ cursor: 'grab', height: BUTTON_HEIGHT }}
                icon={<DragOutlined />}
                type="primary"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  startDrag(e, {
                    dragStartEntity: selectNodes[0],
                    dragEntities: selectNodes,
                  });
                }}
              />
            </Tooltip>
          )}

          <Tooltip title={'Collapse'}>
            <Button
              icon={<ShrinkOutlined />}
              style={{ height: BUTTON_HEIGHT }}
              type="primary"
              onMouseDown={(e) => {
                commandRegistry.executeCommand(FlowCommandId.COLLAPSE);
              }}
            />
          </Tooltip>

          <Tooltip title={'Expand'}>
            <Button
              icon={<ExpandOutlined />}
              style={{ height: BUTTON_HEIGHT }}
              type="primary"
              onMouseDown={(e) => {
                commandRegistry.executeCommand(FlowCommandId.EXPAND);
              }}
            />
          </Tooltip>

          <Tooltip title={'Group'}>
            <Button
              icon={<IconGroupOutlined />}
              type="primary"
              style={{
                display: canGroup ? 'inherit' : 'none',
                height: BUTTON_HEIGHT,
              }}
              onClick={() => {
                commandRegistry.executeCommand(FlowCommandId.GROUP);
              }}
            />
          </Tooltip>

          <Tooltip title={'Copy'}>
            <Button
              icon={<CopyOutlined />}
              style={{ height: BUTTON_HEIGHT }}
              type="primary"
              onClick={() => {
                commandRegistry.executeCommand(FlowCommandId.COPY);
              }}
            />
          </Tooltip>

          <Tooltip title={'Delete'}>
            <Button
              type="primary"
              icon={<DeleteOutlined />}
              style={{ height: BUTTON_HEIGHT }}
              onClick={() => {
                commandRegistry.executeCommand(FlowCommandId.DELETE);
              }}
            />
          </Tooltip>
        </Button.Group>
      </div>
      <div
        style={{ cursor: draggable ? 'grab' : 'auto' }}
        onMouseDown={(e) => {
          e.stopPropagation();
          startDrag(e, {
            dragStartEntity: selectNodes[0],
            dragEntities: selectNodes,
          });
        }}
      >
        {children}
      </div>
    </>
  );
};
