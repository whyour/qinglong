import { DisplayOutputs } from '@flowgram.ai/form-materials';

import { useIsSidebar } from '../../hooks';

export function FormOutputs() {
  const isSidebar = useIsSidebar();
  if (isSidebar) {
    return null;
  }
  return <DisplayOutputs displayFromScope />;
}
