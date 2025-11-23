/**
 * Minimap component for workflow editor
 * Following Flowgram demo pattern from:
 * https://github.com/bytedance/flowgram.ai/blob/main/apps/demo-free-layout/src/components/tools/minimap.tsx
 */
import React from 'react';
import { Minimap as FlowgramMinimap } from '@flowgram.ai/minimap-plugin';

export const Minimap: React.FC = () => {
  return (
    <div className="demo-tools-minimap">
      <FlowgramMinimap
        style={{
          width: '150px',
          height: '100px',
          borderRadius: '8px',
          overflow: 'hidden',
        }}
      />
    </div>
  );
};
