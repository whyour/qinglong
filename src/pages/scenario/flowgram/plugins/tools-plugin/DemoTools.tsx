import React, { useState, useEffect } from 'react';
import {
  usePlaygroundTools,
  useHistoryService,
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
import { Minimap } from '../../components/minimap';
import { useAddNode } from '../../hooks/use-add-node';
import { NODE_TYPES } from '../../nodes/constants';
import './styles.less';

export const DemoTools: React.FC = () => {
  const playgroundTools = usePlaygroundTools();
  const historyService = useHistoryService();
  const addNode = useAddNode();
  
  const [zoom, setZoom] = useState(100);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  useEffect(() => {
    if (playgroundTools) {
      const updateZoom = () => {
        // Use playgroundTools.zoom for reading (Feedback #1)
        const currentZoom = playgroundTools.zoom;
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
    if (playgroundTools?.config) {
      // Use playgroundTools.config.updateZoom for writing (Feedback #1)
      playgroundTools.config.updateZoom(value / 100);
    }
  };

  const handleZoomIn = () => {
    if (playgroundTools?.config) {
      const current = playgroundTools.zoom;
      playgroundTools.config.updateZoom(Math.min(current + 0.1, 2));
    }
  };

  const handleZoomOut = () => {
    if (playgroundTools?.config) {
      const current = playgroundTools.zoom;
      playgroundTools.config.updateZoom(Math.max(current - 0.1, 0.5));
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

  // Use useAddNode hook for node addition (Feedback #2)
  const handleAddNodeClick = async (event: React.MouseEvent<HTMLElement>) => {
    const target = event.currentTarget.getBoundingClientRect();
    await addNode(target);
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

        {/* Minimap component added to toolbar (Feedback #3) */}
        <Minimap />

        <div className="demo-tools-divider" />

        <Tooltip title={intl.get('scenario_alerts')}>
          <Button
            type="text"
            icon={<ExclamationCircleOutlined />}
            className="demo-tools-button"
          />
        </Tooltip>

        <Button
          type="primary"
          icon={<PlusOutlined />}
          className="demo-tools-add-button"
          onClick={handleAddNodeClick}
        >
          {intl.get('scenario_add_node')}
        </Button>

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
