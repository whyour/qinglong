import { type CSSProperties, type FC } from 'react';

import {
  useService,
  useStartDragNode,
  FlowGroupService,
  type FlowNodeEntity,
  type FlowGroupController,
  useClientContext,
} from '@flowgram.ai/fixed-layout-editor';
import { Button, message, Tooltip } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  ExpandOutlined,
  DragOutlined,
  ShrinkOutlined,
} from '@ant-design/icons';

import { writeData } from '../../shortcuts/utils';
import { IconUngroupOutlined } from './icons';

interface GroupToolsProps {
  groupNode: FlowNodeEntity;
  groupController: FlowGroupController;
  visible: boolean;
  style?: CSSProperties;
}

const BUTTON_HEIGHT = 24;

export const GroupTools: FC<GroupToolsProps> = (props) => {
  const { groupNode, groupController, visible, style = {} } = props;

  const groupService = useService<FlowGroupService>(FlowGroupService);
  const { operation, playground, clipboard } = useClientContext();

  const { startDrag } = useStartDragNode();

  const buttonStyle = {
    cursor: 'pointer',
    height: BUTTON_HEIGHT,
  };
  if (playground.config.readonly) return null;

  return (
    <div
      style={{
        display: 'flex',
        opacity: visible ? 1 : 0,
        gap: 5,
        paddingBottom: 5,
        color: 'rgb(97, 69, 211)',
        ...style,
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
      }}
    >
      <Button.Group size="small" style={{ display: 'flex', flexWrap: 'nowrap' }}>
        <Tooltip title="Drag">
          <Button
            style={{ ...buttonStyle, cursor: 'grab' }}
            icon={<DragOutlined />}
            type="primary"
            onMouseDown={(e) => {
              e.stopPropagation();
              startDrag(e, {
                dragStartEntity: groupNode,
                dragEntities: [groupNode],
              });
            }}
          />
        </Tooltip>

        <Tooltip title={groupController?.collapsed ? 'Expand' : 'Collapse'}>
          <Button
            style={buttonStyle}
            icon={groupController?.collapsed ? <ExpandOutlined /> : <ShrinkOutlined />}
            type="primary"
            onClick={(e) => {
              if (!groupController) {
                return;
              }
              e.stopPropagation();
              if (groupController.collapsed) {
                groupController.expand();
              } else {
                groupController.collapse();
              }
            }}
          />
        </Tooltip>
        <Tooltip title="Ungroup">
          <Button
            style={buttonStyle}
            icon={<IconUngroupOutlined />}
            type="primary"
            onClick={() => {
              groupService.ungroup(groupNode);
            }}
          />
        </Tooltip>
        <Tooltip title="Copy">
          <Button
            icon={<CopyOutlined />}
            style={buttonStyle}
            type="primary"
            onClick={() => {
              const nodeJSON = groupNode.toJSON();

              writeData([nodeJSON], clipboard);
              message.success({
                content: 'Copied. You can move to any [+] to paste.',
              });
            }}
          />
        </Tooltip>
        <Tooltip title="Delete">
          <Button
            style={buttonStyle}
            type="primary"
            icon={<DeleteOutlined />}
            onClick={() => {
              operation.deleteNode(groupNode);
            }}
          />
        </Tooltip>
      </Button.Group>
    </div>
  );
};
