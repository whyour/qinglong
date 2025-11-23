import React, { useEffect, useImperativeHandle, forwardRef } from 'react';
import { Button, Tooltip } from 'antd';
import {
  PlusOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  FullscreenOutlined,
  ApiOutlined,
  CodeOutlined,
  BranchesOutlined,
  ClockCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { EditorRenderer, FreeLayoutEditorProvider } from '@flowgram.ai/free-layout-editor';
import '@flowgram.ai/free-layout-editor/index.css';
import intl from 'react-intl-universal';
import { nodeRegistries } from './nodes';
import { useEditorProps } from './hooks/use-editor-props';
import './editor.less';

export interface FlowgramEditorProps {
  initialData?: any;
  onChange?: (data: any) => void;
}

export interface FlowgramEditorRef {
  getData: () => any;
}

const FlowgramEditor = forwardRef<FlowgramEditorRef, FlowgramEditorProps>(
  ({ initialData, onChange }, ref) => {
    const defaultData = initialData || {
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    const editorProps = useEditorProps(defaultData, nodeRegistries);

    useImperativeHandle(ref, () => ({
      getData: () => {
        // This would need to be implemented to get the current editor state
        // For now, return the default data structure
        return defaultData;
      },
    }));

    useEffect(() => {
      if (onChange) {
        // Setup change listener
        // This would need integration with Flowgram's onChange events
      }
    }, [onChange]);

    const handleAddNode = (nodeType: string) => {
      // This will be implemented to add nodes via Flowgram API
      console.log('Add node:', nodeType);
    };

    const handleZoom = (direction: 'in' | 'out' | 'fit') => {
      // This will be implemented to control zoom via Flowgram API
      console.log('Zoom:', direction);
    };

    return (
      <div className="flowgram-editor-container">
        <FreeLayoutEditorProvider {...editorProps}>
          <div className="flowgram-editor-toolbar">
            <div className="toolbar-group">
              <span className="toolbar-label">{intl.get('新建节点')}:</span>
              <Tooltip title={intl.get('HTTP请求')}>
                <Button
                  size="small"
                  icon={<ApiOutlined />}
                  onClick={() => handleAddNode('http')}
                >
                  HTTP
                </Button>
              </Tooltip>
              <Tooltip title={intl.get('脚本执行')}>
                <Button
                  size="small"
                  icon={<CodeOutlined />}
                  onClick={() => handleAddNode('script')}
                >
                  {intl.get('脚本')}
                </Button>
              </Tooltip>
              <Tooltip title={intl.get('条件判断')}>
                <Button
                  size="small"
                  icon={<BranchesOutlined />}
                  onClick={() => handleAddNode('condition')}
                >
                  {intl.get('条件')}
                </Button>
              </Tooltip>
              <Tooltip title={intl.get('延迟')}>
                <Button
                  size="small"
                  icon={<ClockCircleOutlined />}
                  onClick={() => handleAddNode('delay')}
                >
                  {intl.get('延迟')}
                </Button>
              </Tooltip>
              <Tooltip title={intl.get('循环')}>
                <Button
                  size="small"
                  icon={<SyncOutlined />}
                  onClick={() => handleAddNode('loop')}
                >
                  {intl.get('循环')}
                </Button>
              </Tooltip>
            </div>
            <div className="toolbar-group">
              <span className="toolbar-label">{intl.get('视图')}:</span>
              <Tooltip title={intl.get('放大')}>
                <Button
                  size="small"
                  icon={<ZoomInOutlined />}
                  onClick={() => handleZoom('in')}
                />
              </Tooltip>
              <Tooltip title={intl.get('缩小')}>
                <Button
                  size="small"
                  icon={<ZoomOutOutlined />}
                  onClick={() => handleZoom('out')}
                />
              </Tooltip>
              <Tooltip title={intl.get('适应画布')}>
                <Button
                  size="small"
                  icon={<FullscreenOutlined />}
                  onClick={() => handleZoom('fit')}
                />
              </Tooltip>
            </div>
          </div>
          <div className="flowgram-editor-wrapper">
            <EditorRenderer className="flowgram-editor" />
          </div>
        </FreeLayoutEditorProvider>
      </div>
    );
  }
);

FlowgramEditor.displayName = 'FlowgramEditor';

export default FlowgramEditor;
