import { EditorRenderer, FixedLayoutEditorProvider, FixedLayoutPluginContext } from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeRegistries } from './nodes';
import { initialData } from './initial-data';
import { useEditorProps } from './hooks/use-editor-props';
import { DemoTools } from './components';

import '@flowgram.ai/fixed-layout-editor/index.css';
import { useEffect, useRef } from 'react';
import { debounce } from 'lodash';

export const Editor = () => {
  const ref = useRef<FixedLayoutPluginContext | null>(null);
  const editorProps = useEditorProps(initialData, FlowNodeRegistries);

  useEffect(() => {
    const toDispose = ref.current?.document.config.onChange(debounce(() => {
      // 通过 toJSON 获取画布最新的数据
      console.log(ref.current?.document.toJSON())
    }, 1000))

    return () => toDispose?.dispose()
  }, [])

  return (
    <div className="doc-feature-overview">
      <FixedLayoutEditorProvider {...editorProps} ref={ref}>
        <EditorRenderer />
        <DemoTools />
      </FixedLayoutEditorProvider>
    </div>
  );
};
