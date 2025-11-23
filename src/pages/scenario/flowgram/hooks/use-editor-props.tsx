import { useMemo } from 'react';
import { FreeLayoutProps } from '@flowgram.ai/free-layout-editor';
import { createFreeSnapPlugin } from '@flowgram.ai/free-snap-plugin';
import { createFreeLinesPlugin } from '@flowgram.ai/free-lines-plugin';
import { createFreeNodePanelPlugin } from '@flowgram.ai/free-node-panel-plugin';
import { createMinimapPlugin } from '@flowgram.ai/minimap-plugin';
import { createPanelManagerPlugin } from '@flowgram.ai/panel-manager-plugin';
import { FlowNodeRegistry } from '../nodes/http';

export function useEditorProps(
  initialData: any,
  nodeRegistries: FlowNodeRegistry[]
): FreeLayoutProps {
  return useMemo<FreeLayoutProps>(
    () => ({
      background: true,
      playground: {
        preventGlobalGesture: true,
      },
      readonly: false,
      twoWayConnection: true,
      initialData,
      nodeRegistries,
      plugins: [
        createFreeSnapPlugin(),
        createFreeLinesPlugin(),
        createFreeNodePanelPlugin(),
        createMinimapPlugin(),
        createPanelManagerPlugin(),
      ],
      onChange: (data) => {
        console.log('Workflow changed:', data);
      },
    }),
    [initialData, nodeRegistries]
  );
}
