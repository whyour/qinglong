import React, { useState, useEffect, useCallback } from 'react';
import { Modal, Form, Input, message, Button, Drawer, Select, InputNumber, Space } from 'antd';
import { request } from '@/utils/http';
import intl from 'react-intl-universal';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  NodeChange,
  EdgeChange,
  Connection,
  BackgroundVariant,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  NodeRenderers,
  NodeTemplates,
  createNode,
  WorkflowGraph,
} from './nodeTypes';
import { PlusOutlined } from '@ant-design/icons';

const { TextArea } = Input;
const { Option } = Select;

interface ScenarioModalProps {
  visible: boolean;
  scenario: any;
  onCancel: () => void;
  onSuccess: () => void;
}

const VisualWorkflowModal: React.FC<ScenarioModalProps> = ({
  visible,
  scenario,
  onCancel,
  onSuccess,
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [nodeConfigForm] = Form.useForm();

  useEffect(() => {
    if (visible) {
      if (scenario) {
        form.setFieldsValue({
          name: scenario.name,
          description: scenario.description || '',
        });
        
        if (scenario.workflowGraph) {
          setNodes(scenario.workflowGraph.nodes || []);
          setEdges(scenario.workflowGraph.edges || []);
        } else {
          initializeDefaultWorkflow();
        }
      } else {
        form.resetFields();
        initializeDefaultWorkflow();
      }
    }
  }, [visible, scenario, form]);

  const initializeDefaultWorkflow = () => {
    const triggerNode = createNode('trigger', { x: 250, y: 100 }, {
      label: intl.get('时间触发'),
      triggerType: 'time',
      config: { schedule: '0 0 * * *' },
    });
    
    setNodes([triggerNode]);
    setEdges([]);
  };

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [],
  );

  const handleAddNode = (type: string, template: any) => {
    const newNode = createNode(type, { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 }, template);
    setNodes((nds) => [...nds, newNode]);
  };

  const handleNodeClick = (_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    nodeConfigForm.setFieldsValue(node.data);
    setDrawerVisible(true);
  };

  const handleNodeConfigSave = async () => {
    try {
      const values = await nodeConfigForm.validateFields();
      setNodes((nds) =>
        nds.map((node) =>
          node.id === selectedNode?.id
            ? { ...node, data: { ...node.data, ...values } }
            : node
        )
      );
      setDrawerVisible(false);
      message.success(intl.get('配置已保存'));
    } catch (error) {
      console.error('节点配置验证失败:', error);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);

      const workflowGraph: WorkflowGraph = {
        nodes: nodes.map(node => ({
          id: node.id,
          type: node.type || 'default',
          position: node.position,
          data: node.data,
        })),
        edges: edges.map(edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        })),
      };

      const endpoint = scenario ? '/api/scenarios' : '/api/scenarios';
      const method = scenario ? 'put' : 'post';
      const payload = {
        ...values,
        workflowGraph,
        ...(scenario ? { id: scenario.id } : {}),
      };

      const { code } = await request[method](endpoint, payload);
      if (code === 200) {
        message.success(
          scenario ? intl.get('更新成功') : intl.get('创建成功'),
        );
        onSuccess();
      }
    } catch (error) {
      console.error('Failed to save scenario:', error);
    } finally {
      setLoading(false);
    }
  };

  const nodeTypes = {
    trigger: ({ data }: any) => NodeRenderers.trigger({ data, id: '', type: 'trigger', position: { x: 0, y: 0 } }),
    condition: ({ data }: any) => NodeRenderers.condition({ data, id: '', type: 'condition', position: { x: 0, y: 0 } }),
    action: ({ data }: any) => NodeRenderers.action({ data, id: '', type: 'action', position: { x: 0, y: 0 } }),
    control: ({ data }: any) => NodeRenderers.control({ data, id: '', type: 'control', position: { x: 0, y: 0 } }),
    logic_gate: ({ data }: any) => NodeRenderers.logic_gate({ data, id: '', type: 'logic_gate', position: { x: 0, y: 0 } }),
  };

  const renderNodeConfig = () => {
    if (!selectedNode) return null;

    switch (selectedNode.type) {
      case 'trigger':
        return (
          <>
            <Form.Item name="label" label={intl.get('名称')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="triggerType" label={intl.get('触发类型')} rules={[{ required: true }]}>
              <Select>
                <Option value="time">{intl.get('时间触发')}</Option>
                <Option value="webhook">Webhook</Option>
                <Option value="variable">{intl.get('变量监听')}</Option>
                <Option value="task_status">{intl.get('任务状态')}</Option>
                <Option value="system_event">{intl.get('系统事件')}</Option>
              </Select>
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.triggerType !== curr.triggerType}>
              {({ getFieldValue }) => {
                const triggerType = getFieldValue('triggerType');
                if (triggerType === 'time') {
                  return (
                    <Form.Item name={['config', 'schedule']} label="Cron 表达式">
                      <Input placeholder="0 0 * * *" />
                    </Form.Item>
                  );
                } else if (triggerType === 'variable') {
                  return (
                    <Form.Item name={['config', 'watchPath']} label={intl.get('监听路径')}>
                      <Input placeholder="/path/to/watch" />
                    </Form.Item>
                  );
                } else if (triggerType === 'system_event') {
                  return (
                    <>
                      <Form.Item name={['config', 'eventType']} label={intl.get('事件类型')}>
                        <Select>
                          <Option value="disk_space">{intl.get('磁盘空间')}</Option>
                          <Option value="memory">{intl.get('内存使用')}</Option>
                        </Select>
                      </Form.Item>
                      <Form.Item name={['config', 'threshold']} label={intl.get('阈值')}>
                        <InputNumber min={0} max={100} addonAfter="%" />
                      </Form.Item>
                    </>
                  );
                }
                return null;
              }}
            </Form.Item>
          </>
        );

      case 'condition':
        return (
          <>
            <Form.Item name="label" label={intl.get('名称')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="field" label={intl.get('字段名')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="operator" label={intl.get('操作符')} rules={[{ required: true }]}>
              <Select>
                <Option value="equals">=</Option>
                <Option value="not_equals">!=</Option>
                <Option value="greater_than">&gt;</Option>
                <Option value="less_than">&lt;</Option>
                <Option value="contains">{intl.get('包含')}</Option>
                <Option value="not_contains">{intl.get('不包含')}</Option>
              </Select>
            </Form.Item>
            <Form.Item name="value" label={intl.get('值')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </>
        );

      case 'action':
        return (
          <>
            <Form.Item name="label" label={intl.get('名称')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="actionType" label={intl.get('动作类型')} rules={[{ required: true }]}>
              <Select>
                <Option value="run_task">{intl.get('运行任务')}</Option>
                <Option value="set_variable">{intl.get('设置变量')}</Option>
                <Option value="execute_command">{intl.get('执行命令')}</Option>
                <Option value="send_notification">{intl.get('发送通知')}</Option>
              </Select>
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.actionType !== curr.actionType}>
              {({ getFieldValue }) => {
                const actionType = getFieldValue('actionType');
                if (actionType === 'run_task') {
                  return (
                    <Form.Item name="cronId" label={intl.get('任务 ID')}>
                      <InputNumber min={1} style={{ width: '100%' }} />
                    </Form.Item>
                  );
                } else if (actionType === 'set_variable') {
                  return (
                    <>
                      <Form.Item name="name" label={intl.get('变量名')}>
                        <Input />
                      </Form.Item>
                      <Form.Item name="value" label={intl.get('变量值')}>
                        <Input />
                      </Form.Item>
                    </>
                  );
                } else if (actionType === 'execute_command') {
                  return (
                    <Form.Item name="command" label={intl.get('命令')}>
                      <TextArea rows={3} />
                    </Form.Item>
                  );
                } else if (actionType === 'send_notification') {
                  return (
                    <Form.Item name="message" label={intl.get('消息')}>
                      <TextArea rows={3} />
                    </Form.Item>
                  );
                }
                return null;
              }}
            </Form.Item>
          </>
        );

      case 'control':
        return (
          <>
            <Form.Item name="label" label={intl.get('名称')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="controlType" label={intl.get('控制类型')} rules={[{ required: true }]}>
              <Select>
                <Option value="delay">{intl.get('延迟执行')}</Option>
                <Option value="retry">{intl.get('重试策略')}</Option>
                <Option value="circuit_breaker">{intl.get('熔断器')}</Option>
              </Select>
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.controlType !== curr.controlType}>
              {({ getFieldValue }) => {
                const controlType = getFieldValue('controlType');
                if (controlType === 'delay') {
                  return (
                    <Form.Item name="delaySeconds" label={intl.get('延迟时间')}>
                      <InputNumber min={1} addonAfter={intl.get('秒')} />
                    </Form.Item>
                  );
                } else if (controlType === 'retry') {
                  return (
                    <>
                      <Form.Item name="maxRetries" label={intl.get('最大重试次数')}>
                        <InputNumber min={1} max={10} />
                      </Form.Item>
                      <Form.Item name="retryDelay" label={intl.get('重试延迟')}>
                        <InputNumber min={1} addonAfter={intl.get('秒')} />
                      </Form.Item>
                      <Form.Item name="backoffMultiplier" label={intl.get('退避倍数')}>
                        <InputNumber min={1} step={0.5} />
                      </Form.Item>
                    </>
                  );
                } else if (controlType === 'circuit_breaker') {
                  return (
                    <Form.Item name="failureThreshold" label={intl.get('失败熔断阈值')}>
                      <InputNumber min={1} />
                    </Form.Item>
                  );
                }
                return null;
              }}
            </Form.Item>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <Modal
      title={scenario ? intl.get('编辑场景') : intl.get('新建场景')}
      open={visible}
      onCancel={onCancel}
      onOk={handleSubmit}
      confirmLoading={loading}
      width={1400}
      destroyOnClose
      style={{ top: 20 }}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label={intl.get('名称')}
          rules={[{ required: true }]}
        >
          <Input />
        </Form.Item>

        <Form.Item name="description" label={intl.get('描述')}>
          <TextArea rows={2} />
        </Form.Item>

        <Form.Item label={intl.get('工作流设计')}>
          <div style={{ marginBottom: 8 }}>
            <Space>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => handleAddNode('trigger', NodeTemplates.triggers.time)}
              >
                {intl.get('触发器')}
              </Button>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => handleAddNode('condition', NodeTemplates.conditions.equals)}
              >
                {intl.get('条件')}
              </Button>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => handleAddNode('action', NodeTemplates.actions.run_task)}
              >
                {intl.get('动作')}
              </Button>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => handleAddNode('control', NodeTemplates.controls.delay)}
              >
                {intl.get('控制流')}
              </Button>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => handleAddNode('logic_gate', NodeTemplates.logic_gates.and)}
              >
                {intl.get('逻辑门')}
              </Button>
            </Space>
          </div>
          <div
            style={{
              border: '1px solid #d9d9d9',
              borderRadius: 4,
              height: 500,
              overflow: 'hidden',
            }}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={handleNodeClick}
              nodeTypes={nodeTypes}
              fitView
            >
              <Controls />
              <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
            </ReactFlow>
          </div>
        </Form.Item>
      </Form>

      <Drawer
        title={intl.get('节点配置')}
        placement="right"
        onClose={() => setDrawerVisible(false)}
        open={drawerVisible}
        width={400}
        extra={
          <Button type="primary" onClick={handleNodeConfigSave}>
            {intl.get('保存')}
          </Button>
        }
      >
        <Form form={nodeConfigForm} layout="vertical">
          {renderNodeConfig()}
        </Form>
      </Drawer>
    </Modal>
  );
};

export default VisualWorkflowModal;
