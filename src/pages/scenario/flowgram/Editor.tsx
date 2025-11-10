import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Button, Space, message, Drawer, Form, Input, Select, InputNumber } from 'antd';
import {  
  PlusOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { FreeLayoutEditor } from '@flowgram.ai/free-layout-editor';
import { nanoid } from 'nanoid';
import type { FlowgramGraph, FlowgramNode, FlowgramEdge } from './types';
import { nodeTemplates } from './nodes';
import { flowgramToBackend, backendToFlowgram, validateWorkflow, createEdge } from './utils/dataConverter';
import './editor.css';

const { Option } = Select;

interface FlowgramEditorProps {
  value?: FlowgramGraph;
  onChange?: (graph: FlowgramGraph) => void;
}

export const FlowgramEditor: React.FC<FlowgramEditorProps> = ({ value, onChange }) => {
  const editorRef = useRef<any>(null);
  const [graph, setGraph] = useState<FlowgramGraph>(value || { nodes: [], edges: [] });
  const [selectedNode, setSelectedNode] = useState<FlowgramNode | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [form] = Form.useForm();

  // Initialize editor
  useEffect(() => {
    if (value) {
      setGraph(backendToFlowgram(value));
    }
  }, [value]);

  // Notify parent of changes
  const notifyChange = useCallback((newGraph: FlowgramGraph) => {
    setGraph(newGraph);
    if (onChange) {
      onChange(flowgramToBackend(newGraph));
    }
  }, [onChange]);

  // Add node to canvas
  const addNode = useCallback((templateKey: string) => {
    const template = nodeTemplates[templateKey as keyof typeof nodeTemplates];
    if (!template) {
      message.error('未知的节点类型');
      return;
    }

    const newNode = template();
    // Position new node in center with some randomness
    newNode.position = {
      x: 200 + Math.random() * 300,
      y: 100 + Math.random() * 200,
    };

    const newGraph = {
      ...graph,
      nodes: [...graph.nodes, newNode],
    };

    notifyChange(newGraph);
    message.success('节点已添加');
  }, [graph, notifyChange]);

  // Handle node click/double-click to open config
  const handleNodeClick = useCallback((node: FlowgramNode) => {
    setSelectedNode(node);
    form.setFieldsValue(node.data);
    setDrawerVisible(true);
  }, [form]);

  // Save node configuration
  const handleSaveNodeConfig = useCallback(() => {
    if (!selectedNode) return;

    form.validateFields().then((values) => {
      const updatedNodes = graph.nodes.map((node) =>
        node.id === selectedNode.id
          ? { ...node, data: { ...node.data, ...values } }
          : node
      );

      const newGraph = {
        ...graph,
        nodes: updatedNodes,
      };

      notifyChange(newGraph);
      setDrawerVisible(false);
      message.success('节点配置已保存');
    });
  }, [selectedNode, form, graph, notifyChange]);

  // Delete selected node
  const handleDeleteNode = useCallback(() => {
    if (!selectedNode) return;

    const newGraph = {
      nodes: graph.nodes.filter((n) => n.id !== selectedNode.id),
      edges: graph.edges.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id),
    };

    notifyChange(newGraph);
    setDrawerVisible(false);
    message.success('节点已删除');
  }, [selectedNode, graph, notifyChange]);

  // Connect two nodes
  const handleConnect = useCallback((connection: { source: string; target: string }) => {
    const edge = createEdge(connection.source, connection.target);
    const newGraph = {
      ...graph,
      edges: [...graph.edges, edge],
    };

    notifyChange(newGraph);
  }, [graph, notifyChange]);

  // Validate workflow
  const handleValidate = useCallback(() => {
    const validation = validateWorkflow(graph);
    if (validation.valid) {
      message.success('工作流验证通过！');
    } else {
      message.error(`验证失败: ${validation.errors.join(', ')}`);
    }
  }, [graph]);

  // Render node configuration form based on node type
  const renderNodeConfigForm = () => {
    if (!selectedNode) return null;

    const { type, data } = selectedNode;

    switch (type) {
      case 'trigger':
        return (
          <>
            <Form.Item name="label" label="标签" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="triggerType" label="触发类型" rules={[{ required: true }]}>
              <Select>
                <Option value="time">时间触发</Option>
                <Option value="webhook">Webhook</Option>
                <Option value="variable_monitor">变量监听</Option>
                <Option value="task_status">任务状态</Option>
                <Option value="system_event">系统事件</Option>
              </Select>
            </Form.Item>
            {data.triggerType === 'time' && (
              <Form.Item name={['config', 'schedule']} label="Cron表达式">
                <Input placeholder="0 0 * * *" />
              </Form.Item>
            )}
            {data.triggerType === 'variable_monitor' && (
              <Form.Item name={['config', 'watchPath']} label="监听路径">
                <Input placeholder="/path/to/watch" />
              </Form.Item>
            )}
            {data.triggerType === 'system_event' && (
              <>
                <Form.Item name={['config', 'eventType']} label="事件类型">
                  <Select>
                    <Option value="disk">磁盘使用</Option>
                    <Option value="memory">内存使用</Option>
                  </Select>
                </Form.Item>
                <Form.Item name={['config', 'threshold']} label="阈值 (%)">
                  <InputNumber min={0} max={100} />
                </Form.Item>
              </>
            )}
          </>
        );

      case 'condition':
        return (
          <>
            <Form.Item name="label" label="标签" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="field" label="字段" rules={[{ required: true }]}>
              <Input placeholder="data.field" />
            </Form.Item>
            <Form.Item name="operator" label="操作符" rules={[{ required: true }]}>
              <Select>
                <Option value="equals">等于</Option>
                <Option value="not_equals">不等于</Option>
                <Option value="greater_than">大于</Option>
                <Option value="less_than">小于</Option>
                <Option value="contains">包含</Option>
                <Option value="not_contains">不包含</Option>
              </Select>
            </Form.Item>
            <Form.Item name="value" label="值" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </>
        );

      case 'action':
        return (
          <>
            <Form.Item name="label" label="标签" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="actionType" label="动作类型" rules={[{ required: true }]}>
              <Select>
                <Option value="run_task">运行任务</Option>
                <Option value="set_variable">设置变量</Option>
                <Option value="execute_command">执行命令</Option>
                <Option value="send_notification">发送通知</Option>
              </Select>
            </Form.Item>
            {data.actionType === 'run_task' && (
              <Form.Item name="cronId" label="任务ID" rules={[{ required: true }]}>
                <InputNumber min={1} />
              </Form.Item>
            )}
            {data.actionType === 'set_variable' && (
              <>
                <Form.Item name="name" label="变量名" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="value" label="变量值" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
              </>
            )}
            {data.actionType === 'execute_command' && (
              <Form.Item name="command" label="命令" rules={[{ required: true }]}>
                <Input.TextArea rows={3} />
              </Form.Item>
            )}
            {data.actionType === 'send_notification' && (
              <Form.Item name="message" label="消息" rules={[{ required: true }]}>
                <Input.TextArea rows={3} />
              </Form.Item>
            )}
          </>
        );

      case 'control':
        return (
          <>
            <Form.Item name="label" label="标签" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="controlType" label="控制类型" rules={[{ required: true }]}>
              <Select>
                <Option value="delay">延迟</Option>
                <Option value="retry">重试</Option>
                <Option value="circuit_breaker">熔断器</Option>
              </Select>
            </Form.Item>
            {data.controlType === 'delay' && (
              <Form.Item name="delaySeconds" label="延迟时间(秒)" rules={[{ required: true }]}>
                <InputNumber min={1} />
              </Form.Item>
            )}
            {data.controlType === 'retry' && (
              <>
                <Form.Item name="maxRetries" label="最大重试次数">
                  <InputNumber min={1} />
                </Form.Item>
                <Form.Item name="retryDelay" label="重试延迟(秒)">
                  <InputNumber min={1} />
                </Form.Item>
                <Form.Item name="backoffMultiplier" label="退避倍数">
                  <InputNumber min={1} step={0.1} />
                </Form.Item>
              </>
            )}
            {data.controlType === 'circuit_breaker' && (
              <Form.Item name="failureThreshold" label="失败阈值">
                <InputNumber min={1} />
              </Form.Item>
            )}
          </>
        );

      case 'logic_gate':
        return (
          <>
            <Form.Item name="label" label="标签" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="gateType" label="逻辑类型" rules={[{ required: true }]}>
              <Select>
                <Option value="AND">AND (与)</Option>
                <Option value="OR">OR (或)</Option>
              </Select>
            </Form.Item>
          </>
        );

      default:
        return (
          <Form.Item name="label" label="标签" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        );
    }
  };

  // Simple render for now - full Flowgram integration would go here
  return (
    <div className="flowgram-editor-container">
      {/* Toolbar */}
      <div className="flowgram-toolbar">
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={() => addNode('start')}>开始</Button>
          <Select
            placeholder="添加触发器"
            style={{ width: 120 }}
            onSelect={(value) => addNode(value)}
            value={undefined}
          >
            <Option value="trigger-time">时间触发</Option>
            <Option value="trigger-webhook">Webhook</Option>
            <Option value="trigger-variable">变量监听</Option>
            <Option value="trigger-task">任务状态</Option>
            <Option value="trigger-system">系统事件</Option>
          </Select>
          <Button onClick={() => addNode('condition')}>条件</Button>
          <Select
            placeholder="添加动作"
            style={{ width: 120 }}
            onSelect={(value) => addNode(value)}
            value={undefined}
          >
            <Option value="action-run">运行任务</Option>
            <Option value="action-variable">设置变量</Option>
            <Option value="action-command">执行命令</Option>
            <Option value="action-notify">发送通知</Option>
          </Select>
          <Select
            placeholder="添加控制流"
            style={{ width: 120 }}
            onSelect={(value) => addNode(value)}
            value={undefined}
          >
            <Option value="control-delay">延迟</Option>
            <Option value="control-retry">重试</Option>
            <Option value="control-breaker">熔断器</Option>
          </Select>
          <Select
            placeholder="添加逻辑门"
            style={{ width: 120 }}
            onSelect={(value) => addNode(value)}
            value={undefined}
          >
            <Option value="gate-and">AND</Option>
            <Option value="gate-or">OR</Option>
          </Select>
          <Button onClick={() => addNode('end')}>结束</Button>
          <Button icon={<PlayCircleOutlined />} onClick={handleValidate}>验证</Button>
        </Space>
      </div>

      {/* Canvas area - simplified view showing nodes */}
      <div className="flowgram-canvas">
        <div style={{ padding: '20px' }}>
          <h3>工作流节点 ({graph.nodes.length})</h3>
          <Space direction="vertical" style={{ width: '100%' }}>
            {graph.nodes.map((node) => (
              <div
                key={node.id}
                className="node-card"
                onClick={() => handleNodeClick(node)}
                style={{
                  padding: '10px',
                  border: '1px solid #d9d9d9',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  background: '#fff',
                }}
              >
                <div><strong>{node.data.label}</strong></div>
                <div style={{ fontSize: '12px', color: '#999' }}>
                  类型: {node.type} | ID: {node.id}
                </div>
              </div>
            ))}
          </Space>
          
          {graph.edges.length > 0 && (
            <>
              <h3 style={{ marginTop: '20px' }}>连接 ({graph.edges.length})</h3>
              <Space direction="vertical" style={{ width: '100%' }}>
                {graph.edges.map((edge) => (
                  <div
                    key={edge.id}
                    style={{
                      padding: '8px',
                      border: '1px solid #f0f0f0',
                      borderRadius: '4px',
                      fontSize: '12px',
                    }}
                  >
                    {edge.source} → {edge.target}
                  </div>
                ))}
              </Space>
            </>
          )}
        </div>
      </div>

      {/* Node configuration drawer */}
      <Drawer
        title="节点配置"
        placement="right"
        width={400}
        onClose={() => setDrawerVisible(false)}
        open={drawerVisible}
        extra={
          <Space>
            <Button danger icon={<DeleteOutlined />} onClick={handleDeleteNode}>
              删除
            </Button>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveNodeConfig}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          {renderNodeConfigForm()}
        </Form>
      </Drawer>
    </div>
  );
};

export default FlowgramEditor;
