/**
 * Zoom selector component
 */

import React, { useState } from 'react';
import { Dropdown, Menu } from 'antd';
import { usePlayground, usePlaygroundTools } from '@flowgram.ai/free-layout-editor';
import { SelectZoom } from './styles';

export const ZoomSelect: React.FC = () => {
  const tools = usePlaygroundTools({ maxZoom: 2, minZoom: 0.25 });
  const playground = usePlayground();
  const [visible, setVisible] = useState(false);

  const menu = (
    <Menu
      onClick={() => setVisible(false)}
      items={[
        {
          key: 'zoomin',
          label: 'Zoom In',
          onClick: () => tools.zoomin(),
        },
        {
          key: 'zoomout',
          label: 'Zoom Out',
          onClick: () => tools.zoomout(),
        },
        { type: 'divider' },
        {
          key: '50',
          label: 'Zoom to 50%',
          onClick: () => playground.config.updateZoom(0.5),
        },
        {
          key: '100',
          label: 'Zoom to 100%',
          onClick: () => playground.config.updateZoom(1),
        },
        {
          key: '150',
          label: 'Zoom to 150%',
          onClick: () => playground.config.updateZoom(1.5),
        },
        {
          key: '200',
          label: 'Zoom to 200%',
          onClick: () => playground.config.updateZoom(2.0),
        },
      ]}
    />
  );

  return (
    <Dropdown
      overlay={menu}
      trigger={['click']}
      visible={visible}
      onVisibleChange={setVisible}
      placement="topLeft"
    >
      <SelectZoom>{Math.floor(tools.zoom * 100)}%</SelectZoom>
    </Dropdown>
  );
};
