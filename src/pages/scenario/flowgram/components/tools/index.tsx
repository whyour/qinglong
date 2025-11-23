/**
 * Flowgram Tools Component
 * Based on: https://github.com/bytedance/flowgram.ai/tree/main/apps/demo-free-layout/src/components/tools
 */

import React, { useState, useEffect } from 'react';
import { Button, Tooltip, Divider } from 'antd';
import {
  UndoOutlined,
  RedoOutlined,
  PlusOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  FullscreenOutlined,
} from '@ant-design/icons';
import { useClientContext } from '@flowgram.ai/free-layout-editor';
import { ZoomSelect } from './zoom-select';
import { AddNodeDropdown } from './add-node-dropdown';
import { ToolContainer, ToolSection } from './styles';

export const FlowgramTools: React.FC = () => {
  const { history, playground } = useClientContext();
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    const disposable = history.undoRedoService.onChange(() => {
      setCanUndo(history.canUndo());
      setCanRedo(history.canRedo());
    });
    return () => disposable.dispose();
  }, [history]);

  return (
    <ToolContainer className="flowgram-tools">
      <ToolSection>
        <ZoomSelect />
        <Tooltip title="Fit View">
          <Button
            type="text"
            icon={<FullscreenOutlined />}
            onClick={() => playground.viewport.fitView()}
          />
        </Tooltip>
        <Divider type="vertical" style={{ height: '20px', margin: '0 4px' }} />
        <Tooltip title="Undo">
          <Button
            type="text"
            icon={<UndoOutlined />}
            disabled={!canUndo}
            onClick={() => history.undo()}
          />
        </Tooltip>
        <Tooltip title="Redo">
          <Button
            type="text"
            icon={<RedoOutlined />}
            disabled={!canRedo}
            onClick={() => history.redo()}
          />
        </Tooltip>
        <Divider type="vertical" style={{ height: '20px', margin: '0 4px' }} />
        <AddNodeDropdown />
      </ToolSection>
    </ToolContainer>
  );
};
