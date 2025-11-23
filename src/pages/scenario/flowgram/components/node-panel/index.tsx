/**
 * NodePanel component for node type selection
 * Following Flowgram demo pattern from:
 * https://github.com/bytedance/flowgram.ai/blob/main/apps/demo-free-layout/src/components/node-panel/index.tsx
 */
import React from 'react';
import { NodePanelProps } from '@flowgram.ai/free-node-panel-plugin';
import { Card, Row, Col } from 'antd';
import {
  ApiOutlined,
  CodeOutlined,
  BranchesOutlined,
  ClockCircleOutlined,
  SyncOutlined,
  PlayCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import intl from 'react-intl-universal';
import { NODE_TYPES } from '../../nodes/constants';
import './styles.less';

export const NodePanel: React.FC<NodePanelProps> = ({ onSelect, onClose }) => {
  const nodeTypes = [
    {
      type: NODE_TYPES.START,
      label: intl.get('scenario_start'),
      icon: <PlayCircleOutlined style={{ fontSize: 24 }} />,
    },
    {
      type: NODE_TYPES.HTTP,
      label: intl.get('scenario_http_node'),
      icon: <ApiOutlined style={{ fontSize: 24 }} />,
    },
    {
      type: NODE_TYPES.SCRIPT,
      label: intl.get('scenario_script_node'),
      icon: <CodeOutlined style={{ fontSize: 24 }} />,
    },
    {
      type: NODE_TYPES.CONDITION,
      label: intl.get('scenario_condition_node'),
      icon: <BranchesOutlined style={{ fontSize: 24 }} />,
    },
    {
      type: NODE_TYPES.DELAY,
      label: intl.get('scenario_delay_node'),
      icon: <ClockCircleOutlined style={{ fontSize: 24 }} />,
    },
    {
      type: NODE_TYPES.LOOP,
      label: intl.get('scenario_loop_node'),
      icon: <SyncOutlined style={{ fontSize: 24 }} />,
    },
    {
      type: NODE_TYPES.END,
      label: intl.get('scenario_end'),
      icon: <StopOutlined style={{ fontSize: 24 }} />,
    },
  ];

  const handleNodeClick = (type: string) => {
    onSelect?.({
      nodeType: type,
      nodeJSON: {},
    });
  };

  return (
    <div className="node-panel">
      <div className="node-panel-header">
        <span>{intl.get('scenario_add_node')}</span>
      </div>
      <div className="node-panel-content">
        <Row gutter={[8, 8]}>
          {nodeTypes.map((node) => (
            <Col span={12} key={node.type}>
              <Card
                hoverable
                className="node-panel-card"
                onClick={() => handleNodeClick(node.type)}
              >
                <div className="node-panel-card-content">
                  {node.icon}
                  <div className="node-panel-card-label">{node.label}</div>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      </div>
    </div>
  );
};
