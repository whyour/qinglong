import React from 'react';
import { createPlugin } from '@flowgram.ai/free-layout-editor';
import { DemoTools } from './DemoTools';

export const createToolsPlugin = () => {
  return createPlugin({
    name: 'tools-plugin',
    layer: () => <DemoTools />,
  });
};
