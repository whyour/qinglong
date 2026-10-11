import {
  EditorRenderer,
  FixedLayoutEditorProvider,
  FixedLayoutPluginContext,
} from '@flowgram.ai/fixed-layout-editor';
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { FlowNodeRegistries } from './nodes';
import { initialData } from './initial-data';
import { useEditorProps } from './hooks/use-editor-props';
import { DemoTools } from './components';
import { WorkflowGraph } from '../type';
import '@flowgram.ai/fixed-layout-editor/index.css';

export interface EditorHandle {
  snapshot(): Promise<WorkflowGraph | undefined>;
}

export const Editor = forwardRef<EditorHandle, { initialData?: WorkflowGraph }>(
  (props, forwardedRef) => {
    const ref = useRef<FixedLayoutPluginContext | null>(null);
    const editorProps = useEditorProps(
      (props.initialData || initialData) as any,
      FlowNodeRegistries,
    );
    useImperativeHandle(
      forwardedRef,
      () => ({
        async snapshot() {
          const context = ref.current;
          if (!context) return undefined;
          const forms = context.document
            .getAllNodes()
            .map((node) => node.form)
            .filter(Boolean);
          await Promise.all(forms.map((form) => form!.validate()));
          if (forms.some((form) => form!.state.invalid)) return undefined;
          return context.document.toJSON() as WorkflowGraph;
        },
      }),
      [],
    );
    return (
      <div className="doc-feature-overview">
        <FixedLayoutEditorProvider {...editorProps} ref={ref}>
          <EditorRenderer />
          <DemoTools />
        </FixedLayoutEditorProvider>
      </div>
    );
  },
);
