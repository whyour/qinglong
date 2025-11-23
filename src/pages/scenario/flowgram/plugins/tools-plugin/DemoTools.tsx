import React, { useState, useEffect } from 'react';
import {
  usePlaygroundTools,
  useHistoryService,
  useNodeService,
} from '@flowgram.ai/free-layout-editor';
import {
  DesktopOutlined,
  AppstoreOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  FullscreenOutlined,
  LockOutlined,
  UnlockOutlined,
  CommentOutlined,
  UndoOutlined,
  RedoOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { Dropdown, Menu, Button, Tooltip } from 'antd';
import intl from 'react-intl-universal';
import { NODE_TYPES } from '../../nodes/constants';
import './styles.less';

export const DemoTools: React.FC = () => {
  const playgroundTools = usePlaygroundTools();
  const historyService = useHistoryService();
  const nodeService = useNodeService();
  
  const [zoom, setZoom] = useState(100);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  useEffect(() => {
    if (playgroundTools) {
      const updateZoom = () => {
        const currentZoom = playgroundTools.getZoom();
        setZoom(Math.round(currentZoom * 100));
      };
      updateZoom();
      
      // Listen for zoom changes
      const unsubscribe = playgroundTools.onZoomChange?.(updateZoom);
      return () => unsubscribe?.();
    }
  }, [playgroundTools]);

  useEffect(() => {
    if (historyService) {
      const updateHistory = () => {
        setCanUndo(historyService.canUndo());
        setCanRedo(historyService.canRedo());
      };
      updateHistory();
      
      const unsubscribe = historyService.onChange?.(updateHistory);
      return () => unsubscribe?.();
    }
  }, [historyService]);

  const handleZoom = (value: number) => {
    if (playgroundTools) {
      playgroundTools.setZoom(value / 100);
    }
  };

  const handleZoomIn = () => {
    if (playgroundTools) {
      const current = playgroundTools.getZoom();
      playgroundTools.setZoom(Math.min(current + 0.1, 2));
    }
  };

  const handleZoomOut = () => {
    if (playgroundTools) {
      const current = playgroundTools.getZoom();
      playgroundTools.setZoom(Math.max(current - 0.1, 0.5));
    }
  };

  const handleFitView = () => {
    if (playgroundTools?.viewport) {
      playgroundTools.viewport.fitView();
    }
  };

  const handleUndo = () => {
    if (historyService && canUndo) {
      historyService.undo();
    }
  };

  const handleRedo = () => {
    if (historyService && canRedo) {
      historyService.redo();
    }
  };

  const handleAddNode = (type: string) => {
    if (nodeService && playgroundTools?.viewport) {
      const center = playgroundTools.viewport.getCenter();
      nodeService.createNode({
        type,
        position: center,
      });
    }
  };

  const zoomMenu = (
    <Menu
      onClick={({ key }) => handleZoom(Number(key))}
      items={[
        { key: '50', label: '50%' },
        { key: '75', label: '75%' },
        { key: '100', label: '100%' },
        { key: '125', label: '125%' },
        { key: '150', label: '150%' },
        { key: '200', label: '200%' },
      ]}
    />
  );

  const addNodeMenu = (
    <Menu
      onClick={({ key }) => handleAddNode(key)}
      items={[
        { key: NODE_TYPES.HTTP, label: intl.get('scenario_http_node'), icon: <PlusOutlined /> },
        { key: NODE_TYPES.SCRIPT, label: intl.get('scenario_script_node'), icon: <PlusOutlined /> },
        { key: NODE_TYPES.CONDITION, label: intl.get('scenario_condition_node'), icon: <PlusOutlined /> },
        { key: NODE_TYPES.DELAY, label: intl.get('scenario_delay_node'), icon: <PlusOutlined /> },
        { key: NODE_TYPES.LOOP, label: intl.get('scenario_loop_node'), icon: <PlusOutlined /> },
      ]}
    />
  );

  return (
    <div className="demo-tools">
      <div className="demo-tools-section">
        <Tooltip title={intl.get('scenario_fit_view')}>
          <Button
            type="text"
            icon={<DesktopOutlined />}
            onClick={handleFitView}
            className="demo-tools-button"
          />
        </Tooltip>
        
        <Tooltip title={intl.get('scenario_grid_view')}>
          <Button
            type="text"
            icon={<AppstoreOutlined />}
            className="demo-tools-button"
          />
        </Tooltip>

        <div className="demo-tools-divider" />

        <Dropdown overlay={zoomMenu} trigger={['click']}>
          <Button type="text" className="demo-tools-button demo-tools-zoom">
            {zoom}%
          </Button>
        </Dropdown>

        <Tooltip title={intl.get('scenario_zoom_in')}>
          <Button
            type="text"
            icon={<ZoomInOutlined />}
            onClick={handleZoomIn}
            className="demo-tools-button"
          />
        </Tooltip>

        <Tooltip title={intl.get('scenario_zoom_out')}>
          <Button
            type="text"
            icon={<ZoomOutOutlined />}
            onClick={handleZoomOut}
            className="demo-tools-button"
          />
        </Tooltip>

        <Tooltip title={intl.get('scenario_fit_canvas')}>
          <Button
            type="text"
            icon={<FullscreenOutlined />}
            onClick={handleFitView}
            className="demo-tools-button"
          />
        </Tooltip>

        <div className="demo-tools-divider" />

        <Tooltip title={isLocked ? intl.get('scenario_unlock') : intl.get('scenario_lock')}>
          <Button
            type="text"
            icon={isLocked ? <LockOutlined /> : <UnlockOutlined />}
            onClick={() => setIsLocked(!isLocked)}
            className="demo-tools-button"
          />
        </Tooltip>

        <Tooltip title={intl.get('scenario_comments')}>
          <Button
            type="text"
            icon={<CommentOutlined />}
            className="demo-tools-button"
          />
        </Tooltip>

        <div className="demo-tools-divider" />

        <Tooltip title={intl.get('scenario_undo')}>
          <Button
            type="text"
            icon={<UndoOutlined />}
            onClick={handleUndo}
            disabled={!canUndo}
            className="demo-tools-button"
          />
        </Tooltip>

        <Tooltip title={intl.get('scenario_redo')}>
          <Button
            type="text"
            icon={<RedoOutlined />}
            onClick={handleRedo}
            disabled={!canRedo}
            className="demo-tools-button"
          />
        </Tooltip>

        <div className="demo-tools-divider" />

        <Tooltip title={intl.get('scenario_alerts')}>
          <Button
            type="text"
            icon={<ExclamationCircleOutlined />}
            className="demo-tools-button"
          />
        </Tooltip>

        <Dropdown overlay={addNodeMenu} trigger={['click']}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            className="demo-tools-add-button"
          >
            {intl.get('scenario_add_node')}
          </Button>
        </Dropdown>

        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          className="demo-tools-run-button"
          style={{ backgroundColor: '#52c41a', borderColor: '#52c41a' }}
        >
          {intl.get('scenario_test_run')}
        </Button>
      </div>
    </div>
  );
};
