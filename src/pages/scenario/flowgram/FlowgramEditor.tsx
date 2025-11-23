import React, { useEffect, useImperativeHandle, forwardRef } from 'react';
import { EditorRenderer, FreeLayoutEditorProvider } from '@flowgram.ai/free-layout-editor';
import { DockedPanelLayer } from '@flowgram.ai/panel-manager-plugin';
import '@flowgram.ai/free-layout-editor/index.css';
import { nodeRegistries } from './nodes';
import { useEditorProps } from './hooks/use-editor-props';
import { FlowgramTools } from './components/tools';
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

    return (
      <div className="flowgram-editor-container">
        <FreeLayoutEditorProvider {...editorProps}>
          <div className="flowgram-editor-wrapper">
            <EditorRenderer className="flowgram-editor" />
            <DockedPanelLayer />
            <FlowgramTools />
          </div>
        </FreeLayoutEditorProvider>
      </div>
    );
  }
);

FlowgramEditor.displayName = 'FlowgramEditor';

export default FlowgramEditor;
