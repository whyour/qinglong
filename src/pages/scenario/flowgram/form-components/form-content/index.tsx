import React from 'react';

import { FlowNodeRegistry } from '@flowgram.ai/fixed-layout-editor';

import { useIsSidebar, useNodeRenderContext } from '../../hooks';
import { FormTitleDescription, FormWrapper } from './styles';

/**
 * @param props
 * @constructor
 */
export function FormContent(props: { children?: React.ReactNode }) {
  const { node, expanded } = useNodeRenderContext();
  const isSidebar = useIsSidebar();
  const registry = node.getNodeRegistry<FlowNodeRegistry>();
  return (
    <FormWrapper>
      <>
        {isSidebar && <FormTitleDescription>{registry.info?.description}</FormTitleDescription>}
        {(expanded || isSidebar) && props.children}
      </>
    </FormWrapper>
  );
}
