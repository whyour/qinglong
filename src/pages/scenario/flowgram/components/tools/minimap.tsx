import { MinimapRender } from '@flowgram.ai/minimap-plugin';

import { MinimapContainer } from './styles';

export const Minimap = ({ visible }: { visible?: boolean }) => {
  if (!visible) {
    return <></>;
  }
  return (
    <MinimapContainer>
      <MinimapRender
        panelStyles={{}}
        containerStyles={{
          pointerEvents: 'auto',
          position: 'relative',
          top: 'unset',
          right: 'unset',
          bottom: 'unset',
          left: 'unset',
        }}
        inactiveStyle={{
          opacity: 1,
          scale: 1,
          translateX: 0,
          translateY: 0,
        }}
      />
    </MinimapContainer>
  );
};
