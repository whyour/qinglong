import React, { useState, useEffect } from 'react';
import {
  Modal,
  Button,
  Space,
  message,
  Card,
  Form,
  Input,
  Select,
  InputNumber,
} from 'antd';
import {
  PlusOutlined,
  SaveOutlined,
  DeleteOutlined,
  CheckOutlined,
} from '@ant-design/icons';
import intl from 'react-intl-universal';
import { WorkflowGraph, WorkflowNode, NodeType } from './type';
import './workflowEditor.less';

interface WorkflowEditorModalProps {
  visible: boolean;
  workflowGraph?: WorkflowGraph;
  onOk: (graph: WorkflowGraph) => void;
  onCancel: () => void;
}

const { TextArea } = Input;
const { Option } = Select;

const WorkflowEditorModal: React.FC<WorkflowEditorModalProps> = ({
  visible,
  workflowGraph,
  onOk,
  onCancel,
}) => {
  const [localGraph, setLocalGraph] = useState<WorkflowGraph>({
    nodes: [],
    startNode: undefined,
  });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    if (visible && workflowGraph) {
      setLocalGraph(workflowGraph);
      setSelectedNodeId(null);
    } else if (visible) {
      setLocalGraph({ nodes: [], startNode: undefined });
      setSelectedNodeId(null);
    }
  }, [visible, workflowGraph]);

  useEffect(() => {
    if (selectedNodeId) {
      const node = localGraph.nodes.find((n) => n.id === selectedNodeId);
      if (node) {
        form.setFieldsValue({
          label: node.label,
          type: node.type,
          ...node.config,
        });
      }
    } else {
      form.resetFields();
    }
  }, [selectedNodeId, localGraph, form]);

  const addNode = (type: NodeType) => {
    const newNode: WorkflowNode = {
      id: `node_${Date.now()}`,
      type,
      label: `${intl.get(getNodeTypeName(type))} ${localGraph.nodes.length + 1}`,
      config: {},
      x: 100 + (localGraph.nodes.length % 5) * 150,
      y: 100 + Math.floor(localGraph.nodes.length / 5) * 100,
    };

    setLocalGraph({
      ...localGraph,
      nodes: [...localGraph.nodes, newNode],
    });
    setSelectedNodeId(newNode.id);
    message.success(`${intl.get('添加节点')}成功`);
  };

  const getNodeTypeName = (type: NodeType): string => {
    const typeMap: Record<NodeType, string> = {
      http: 'HTTP请求',
      script: '脚本执行',
      condition: '条件判断',
      delay: '延迟',
      loop: '循环',
    };
    return typeMap[type];
  };

  const deleteNode = () => {
    if (!selectedNodeId) {
      message.warning(intl.get('请选择节点'));
      return;
    }

    Modal.confirm({
      title: intl.get('确认删除节点'),
      content: `${intl.get('确认')}${intl.get('删除节点')}${intl.get('吗')}？`,
      onOk: () => {
        setLocalGraph({
          ...localGraph,
          nodes: localGraph.nodes.filter((n) => n.id !== selectedNodeId),
        });
        setSelectedNodeId(null);
        message.success(`${intl.get('删除')}成功`);
      },
    });
  };

  const updateNode = () => {
    if (!selectedNodeId) {
      return;
    }

    form.validateFields().then((values) => {
      const updatedNodes = localGraph.nodes.map((node) => {
        if (node.id === selectedNodeId) {
          return {
            ...node,
            label: values.label,
            type: values.type,
            config: {
              ...values,
            },
          };
        }
        return node;
      });

      setLocalGraph({
        ...localGraph,
        nodes: updatedNodes,
      });
      message.success(`${intl.get('保存')}成功`);
    });
  };

  const validateWorkflow = () => {
    if (localGraph.nodes.length === 0) {
      message.warning(intl.get('工作流至少需要一个节点'));
      return false;
    }
    message.success(intl.get('工作流验证通过'));
    return true;
  };

  const handleOk = () => {
    if (validateWorkflow()) {
      onOk(localGraph);
    }
  };

  const renderNodeConfig = () => {
    if (!selectedNodeId) {
      return (
        <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
          {intl.get('请选择节点')}
        </div>
      );
    }

    const selectedNode = localGraph.nodes.find((n) => n.id === selectedNodeId);
    if (!selectedNode) return null;

    return (
      <Form form={form} layout="vertical" onValuesChange={updateNode}>
        <Form.Item
          name="label"
          label={intl.get('节点标签')}
          rules={[{ required: true, message: intl.get('请输入节点标签') }]}
        >
          <Input placeholder={intl.get('请输入节点标签')} />
        </Form.Item>

        <Form.Item
          name="type"
          label={intl.get('节点类型')}
          rules={[{ required: true, message: intl.get('选择节点类型') }]}
        >
          <Select placeholder={intl.get('选择节点类型')} disabled>
            <Option value="http">{intl.get('HTTP请求')}</Option>
            <Option value="script">{intl.get('脚本执行')}</Option>
            <Option value="condition">{intl.get('条件判断')}</Option>
            <Option value="delay">{intl.get('延迟')}</Option>
            <Option value="loop">{intl.get('循环')}</Option>
          </Select>
        </Form.Item>

        {selectedNode.type === 'http' && (
          <>
            <Form.Item
              name="url"
              label={intl.get('请求URL')}
              rules={[{ required: true, message: intl.get('请输入URL') }]}
            >
              <Input placeholder="https://api.example.com/endpoint" />
            </Form.Item>
            <Form.Item name="method" label={intl.get('请求方法')}>
              <Select defaultValue="GET">
                <Option value="GET">GET</Option>
                <Option value="POST">POST</Option>
                <Option value="PUT">PUT</Option>
                <Option value="DELETE">DELETE</Option>
              </Select>
            </Form.Item>
            <Form.Item name="headers" label={intl.get('请求头')}>
              <TextArea
                rows={3}
                placeholder='{"Content-Type": "application/json"}'
              />
            </Form.Item>
            <Form.Item name="body" label={intl.get('请求体')}>
              <TextArea rows={4} placeholder='{"key": "value"}' />
            </Form.Item>
          </>
        )}

        {selectedNode.type === 'script' && (
          <>
            <Form.Item name="scriptPath" label={intl.get('脚本路径')}>
              <Input placeholder="/path/to/script.js" />
            </Form.Item>
            <Form.Item name="scriptContent" label={intl.get('脚本内容')}>
              <TextArea
                rows={6}
                placeholder="console.log('Hello World');"
              />
            </Form.Item>
          </>
        )}

        {selectedNode.type === 'condition' && (
          <Form.Item
            name="condition"
            label={intl.get('条件表达式')}
            rules={[{ required: true, message: intl.get('请输入条件表达式') }]}
          >
            <TextArea
              rows={4}
              placeholder="response.status === 200"
            />
          </Form.Item>
        )}

        {selectedNode.type === 'delay' && (
          <Form.Item
            name="delayMs"
            label={`${intl.get('延迟时间')} (毫秒)`}
            rules={[{ required: true, message: intl.get('请输入延迟时间') }]}
          >
            <InputNumber
              min={0}
              style={{ width: '100%' }}
              placeholder="1000"
            />
          </Form.Item>
        )}

        {selectedNode.type === 'loop' && (
          <Form.Item
            name="iterations"
            label={intl.get('迭代次数')}
            rules={[{ required: true, message: intl.get('请输入迭代次数') }]}
          >
            <InputNumber
              min={1}
              style={{ width: '100%' }}
              placeholder="5"
            />
          </Form.Item>
        )}

        <Form.Item>
          <Space>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={updateNode}
            >
              {intl.get('保存')}
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={deleteNode}
            >
              {intl.get('删除')}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    );
  };

  return (
    <Modal
      title={intl.get('工作流编辑器')}
      open={visible}
      onOk={handleOk}
      onCancel={onCancel}
      width="95vw"
      style={{ top: 20 }}
      bodyStyle={{ height: '85vh', padding: 0 }}
      okText={intl.get('保存工作流')}
      cancelText={intl.get('取消')}
    >
      <div className="workflow-editor-container">
        {/* Left Canvas Area */}
        <div className="workflow-canvas">
          <div className="workflow-toolbar">
            <Space wrap>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                size="small"
                onClick={() => addNode('http')}
              >
                {intl.get('HTTP请求')}
              </Button>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                size="small"
                onClick={() => addNode('script')}
              >
                {intl.get('脚本执行')}
              </Button>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                size="small"
                onClick={() => addNode('condition')}
              >
                {intl.get('条件判断')}
              </Button>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                size="small"
                onClick={() => addNode('delay')}
              >
                {intl.get('延迟')}
              </Button>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                size="small"
                onClick={() => addNode('loop')}
              >
                {intl.get('循环')}
              </Button>
              <Button
                icon={<CheckOutlined />}
                size="small"
                onClick={validateWorkflow}
              >
                {intl.get('验证工作流')}
              </Button>
            </Space>
          </div>

          <div className="workflow-nodes-area">
            {localGraph.nodes.length === 0 ? (
              <div className="empty-canvas">
                <p>{intl.get('暂无节点，请点击上方按钮添加节点')}</p>
              </div>
            ) : (
              <div className="nodes-grid">
                {localGraph.nodes.map((node) => (
                  <Card
                    key={node.id}
                    className={`node-card ${
                      selectedNodeId === node.id ? 'node-card-selected' : ''
                    }`}
                    hoverable
                    onClick={() => setSelectedNodeId(node.id)}
                    size="small"
                  >
                    <div className="node-card-header">
                      <span className="node-type-badge">
                        {intl.get(getNodeTypeName(node.type))}
                      </span>
                    </div>
                    <div className="node-card-body">
                      <div className="node-label">{node.label}</div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Edit Panel */}
        <div className="workflow-edit-panel">
          <div className="edit-panel-header">
            <h3>{intl.get('节点配置')}</h3>
          </div>
          <div className="edit-panel-body">{renderNodeConfig()}</div>
        </div>
      </div>
    </Modal>
  );
};

export default WorkflowEditorModal;
