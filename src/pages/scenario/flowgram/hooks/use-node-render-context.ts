import { useContext } from 'react';

import { NodeRenderContext } from '../context';

export function useNodeRenderContext() {
  return useContext(NodeRenderContext);
}
