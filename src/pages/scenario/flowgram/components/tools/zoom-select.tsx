import { useState } from 'react';

import { usePlaygroundTools } from '@flowgram.ai/fixed-layout-editor';
import { Divider, Dropdown, Menu } from 'antd';

import { SelectZoom } from './styles';

export const ZoomSelect = () => {
  const tools = usePlaygroundTools({ maxZoom: 2, minZoom: 0.25 });
  const [dropDownVisible, openDropDown] = useState(false);
  return (
    <Dropdown
      placement="top"
      visible={dropDownVisible}
      // onClickOutSide={() => openDropDown(false)}
      dropdownRender={() => (
        <Menu>
          <Menu.Item onClick={() => tools.zoomin()}>Zoomin</Menu.Item>
          <Menu.Item onClick={() => tools.zoomout()}>Zoomout</Menu.Item>
          <Divider layout="horizontal" />
          <Menu.Item onClick={() => tools.updateZoom(0.5)}>50%</Menu.Item>
          <Menu.Item onClick={() => tools.updateZoom(1)}>100%</Menu.Item>
          <Menu.Item onClick={() => tools.updateZoom(1.5)}>150%</Menu.Item>
          <Menu.Item onClick={() => tools.updateZoom(2.0)}>200%</Menu.Item>
        </Menu>
      )}
    >
      <SelectZoom onClick={() => openDropDown(true)}>{Math.floor(tools.zoom * 100)}%</SelectZoom>
    </Dropdown>
  );
};
