import { useState, useEffect } from 'react';

import { usePlayground, usePlaygroundTools, useRefresh } from '@flowgram.ai/fixed-layout-editor';
import { Tooltip, Button } from 'antd';

import { ZoomSelect } from './zoom-select';
import { SwitchVertical } from './switch-vertical';
import { ToolContainer, ToolSection } from './styles';
import { Save } from './save';
import { Run } from './run';
import { Readonly } from './readonly';
import { MinimapSwitch } from './minimap-switch';
import { Minimap } from './minimap';
import { Interactive } from './interactive';
import { FitView } from './fit-view';
import { RedoOutlined, UndoOutlined } from '@ant-design/icons';

export const DemoTools = () => {
  const tools = usePlaygroundTools();
  const [minimapVisible, setMinimapVisible] = useState(false);
  const playground = usePlayground();
  const refresh = useRefresh();

  useEffect(() => {
    const disposable = playground.config.onReadonlyOrDisabledChange(() => refresh());
    return () => disposable.dispose();
  }, [playground]);

  return (
    <ToolContainer className="fixed-demo-tools">
      <ToolSection>
        <Interactive />
        <SwitchVertical />
        <ZoomSelect />
        <FitView fitView={tools.fitView} />
        <MinimapSwitch minimapVisible={minimapVisible} setMinimapVisible={setMinimapVisible} />
        <Minimap visible={minimapVisible} />
        <Readonly />
        <Tooltip title="Undo">
          <Button
            icon={<UndoOutlined />}
            disabled={!tools.canUndo || playground.config.readonly}
            onClick={() => tools.undo()}
          />
        </Tooltip>
        <Tooltip title="Redo">
          <Button
            icon={<RedoOutlined />}
            disabled={!tools.canRedo || playground.config.readonly}
            onClick={() => tools.redo()}
          />
        </Tooltip>
        <Save disabled={playground.config.readonly} />
        <Run />
      </ToolSection>
    </ToolContainer>
  );
};
