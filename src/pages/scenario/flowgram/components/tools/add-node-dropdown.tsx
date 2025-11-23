/**
 * Add Node dropdown component
 */

import React from 'react';
import { Button, Dropdown, Menu } from 'antd';
import {
  PlusOutlined,
  ApiOutlined,
  CodeOutlined,
  BranchesOutlined,
  ClockCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { usePlayground } from '@flowgram.ai/free-layout-editor';
import { nanoid } from 'nanoid';
import intl from 'react-intl-universal';

export const AddNodeDropdown: React.FC = () => {
  const playground = usePlayground();

  const handleAddNode = (type: string) => {
    // Get center of viewport
    const viewport = playground.viewport.getViewport();
    const centerX = viewport.x + viewport.width / 2;
    const centerY = viewport.y + viewport.height / 2;

    // Add node at center
    const nodeId = nanoid();
    playground.nodeService.createNode({
      id: nodeId,
      type,
      x: centerX - 140, // Offset to center the node (280px width / 2)
      y: centerY - 60,  // Offset to center the node (120px height / 2)
      width: type === 'start' || type === 'end' ? 120 : 280,
      height: type === 'delay' || type === 'loop' ? 100 : 120,
    });
  };

  const menu = (
    <Menu
      items={[
        {
          key: 'http',
          label: intl.get('scenario_http_node'),
          icon: <ApiOutlined />,
          onClick: () => handleAddNode('http'),
        },
        {
          key: 'script',
          label: intl.get('scenario_script_node'),
          icon: <CodeOutlined />,
          onClick: () => handleAddNode('script'),
        },
        {
          key: 'condition',
          label: intl.get('scenario_condition_node'),
          icon: <BranchesOutlined />,
          onClick: () => handleAddNode('condition'),
        },
        {
          key: 'delay',
          label: intl.get('scenario_delay_node'),
          icon: <ClockCircleOutlined />,
          onClick: () => handleAddNode('delay'),
        },
        {
          key: 'loop',
          label: intl.get('scenario_loop_node'),
          icon: <SyncOutlined />,
          onClick: () => handleAddNode('loop'),
        },
      ]}
    />
  );

  return (
    <Dropdown overlay={menu} trigger={['click']} placement="topLeft">
      <Button
        type="primary"
        icon={<PlusOutlined />}
        style={{
          backgroundColor: 'rgba(24, 144, 255, 0.1)',
          color: '#1890ff',
          border: '1px solid rgba(24, 144, 255, 0.3)',
          borderRadius: '8px',
        }}
      >
        {intl.get('scenario_add_node')}
      </Button>
    </Dropdown>
  );
};
