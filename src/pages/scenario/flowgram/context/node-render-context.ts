import React from 'react';

import { type NodeRenderReturnType } from '@flowgram.ai/fixed-layout-editor';

export const NodeRenderContext = React.createContext<NodeRenderReturnType>({} as any);
