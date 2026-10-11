import { useContext, useCallback, useMemo, useState } from 'react';

import { usePanelManager } from '@flowgram.ai/panel-manager-plugin';
import { useClientContext } from '@flowgram.ai/fixed-layout-editor';
import { Dropdown, Button, Menu } from 'antd';
import { CloseOutlined, LeftOutlined } from '@ant-design/icons';
import { MenuOutlined } from '@ant-design/icons';

import { FlowNodeRegistry } from '../../typings';
import { FlowCommandId } from '../../shortcuts/constants';
import { useIsSidebar } from '../../hooks';
import { NodeRenderContext } from '../../context';
import { nodeFormPanelFactory } from '../../components/sidebar';
import { getIcon } from './utils';
import { TitleInput } from './title-input';
import { Header, Operators } from './styles';

function DropdownContent(props: { updateTitleEdit: (editing: boolean) => void }) {
  const { updateTitleEdit } = props;
  const { node, deleteNode } = useContext(NodeRenderContext);
  const clientContext = useClientContext();
  const registry = node.getNodeRegistry<FlowNodeRegistry>();

  const handleCopy = useCallback(
    () => {
      clientContext.playground.commandService.executeCommand(FlowCommandId.COPY, node);
      // e.stopPropagation(); // Disable clicking prevents the sidebar from opening
    },
    [clientContext, node]
  );

  const handleDelete = useCallback(
    () => {
      deleteNode();
      // e.stopPropagation(); // Disable clicking prevents the sidebar from opening
    },
    [clientContext, node]
  );

  const handleEditTitle = useCallback(() => {
    updateTitleEdit(true);
  }, [updateTitleEdit]);

  const deleteDisabled = useMemo(() => {
    if (registry.canDelete) {
      return !registry.canDelete(clientContext, node);
    }
    return registry.meta!.deleteDisable;
  }, [registry, node]);

  return (
    <Menu>
      <Menu.Item onClick={handleEditTitle}>Edit Title</Menu.Item>
      <Menu.Item onClick={handleCopy} disabled={registry.meta!.copyDisable === true}>
        Copy
      </Menu.Item>
      <Menu.Item onClick={handleDelete} disabled={deleteDisabled}>
        Delete
      </Menu.Item>
    </Menu>
  );
}

export function FormHeader() {
  const { node, expanded, startDrag, toggleExpand, readonly } = useContext(NodeRenderContext);
  const [titleEdit, updateTitleEdit] = useState<boolean>(false);
  const panelManager = usePanelManager();
  const isSidebar = useIsSidebar();
  const handleExpand = (e: React.MouseEvent) => {
    toggleExpand();
    e.stopPropagation(); // Disable clicking prevents the sidebar from opening
  };
  const handleClose = () => {
    panelManager.close(nodeFormPanelFactory.key);
  };

  return (
    <Header
      onMouseDown={(e) => {
        // trigger drag node
        startDrag(e);
        e.stopPropagation();
      }}
    >
      {getIcon(node)}
      <TitleInput readonly={readonly} titleEdit={titleEdit} updateTitleEdit={updateTitleEdit} />
      {node.renderData.expandable && !isSidebar && (
        <Button
          type="primary"
          icon={expanded ? <LeftOutlined /> : <LeftOutlined rotate={90} />}
          size="small"
          onClick={handleExpand}
        />
      )}
      {readonly ? undefined : (
        <Operators>
          <Dropdown
            trigger={['hover']}
            dropdownRender={() => <DropdownContent updateTitleEdit={updateTitleEdit} />}
          >
            <Button
              color="secondary"
              size="small"
              icon={<MenuOutlined />}
              onClick={(e) => e.stopPropagation()}
            />
          </Dropdown>
        </Operators>
      )}
      {isSidebar && (
        <Button
          type="primary"
          icon={<CloseOutlined />}
          size="small"
          onClick={handleClose}
        />
      )}
    </Header>
  );
}
