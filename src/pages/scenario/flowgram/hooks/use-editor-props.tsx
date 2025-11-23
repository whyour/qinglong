import { useMemo } from 'react';
import { FreeLayoutProps } from '@flowgram.ai/free-layout-editor';
import { createFreeSnapPlugin } from '@flowgram.ai/free-snap-plugin';
import { createFreeLinesPlugin } from '@flowgram.ai/free-lines-plugin';
import { createFreeNodePanelPlugin } from '@flowgram.ai/free-node-panel-plugin';
import { createMinimapPlugin } from '@flowgram.ai/minimap-plugin';
import { createPanelManagerPlugin } from '@flowgram.ai/panel-manager-plugin';
import { createHistoryNodePlugin } from '@flowgram.ai/history-node-plugin';
import { FlowNodeRegistry } from '../nodes/http';
import { createToolsPlugin } from '../plugins/tools-plugin';

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
      plugins: () => [
        createFreeSnapPlugin({}),
        createFreeLinesPlugin({}),
        createFreeNodePanelPlugin({}),
        createHistoryNodePlugin(),
        createMinimapPlugin({
          style: {
            width: '150px',
            height: '100px',
            bottom: '20px',
            right: '20px',
          },
        }),
        createPanelManagerPlugin({
          factories: [],
          layerProps: {},
        }),
        createToolsPlugin(),
      ],
      onChange: (data) => {
        console.log('Workflow changed:', data);
      },
    }),
    [initialData, nodeRegistries]
  );
}
