import { useMemo } from 'react';
import { FreeLayoutProps } from '@flowgram.ai/free-layout-editor';
import { createFreeSnapPlugin } from '@flowgram.ai/free-snap-plugin';
import { createFreeLinesPlugin } from '@flowgram.ai/free-lines-plugin';
import { createFreeNodePanelPlugin } from '@flowgram.ai/free-node-panel-plugin';
import { createPanelManagerPlugin } from '@flowgram.ai/panel-manager-plugin';
import { createHistoryNodePlugin } from '@flowgram.ai/history-node-plugin';
import { FlowNodeRegistry } from '../nodes/http';
import { createToolsPlugin } from '../plugins/tools-plugin';
import { NodePanel } from '../components/node-panel';

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
        createFreeNodePanelPlugin({
          renderer: NodePanel,
        }),
        createHistoryNodePlugin({}),
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
