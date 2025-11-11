import React, { useState, useEffect, useRef } from 'react';
import { Modal, Form, Input, message } from 'antd';
import { request } from '@/utils/http';
import intl from 'react-intl-universal';
import { FreeLayoutEditor } from '@flowgram.ai/free-layout-editor';
import '@flowgram.ai/free-layout-editor/index.css';

const { TextArea } = Input;

interface ScenarioModalProps {
  visible: boolean;
  scenario: any;
  onCancel: () => void;
  onSuccess: () => void;
}

const ScenarioModal: React.FC<ScenarioModalProps> = ({
  visible,
  scenario,
  onCancel,
  onSuccess,
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const editorRef = useRef<any>(null);
  const [workflowGraph, setWorkflowGraph] = useState<any>(null);

  useEffect(() => {
    if (visible) {
      if (scenario) {
        form.setFieldsValue({
          name: scenario.name,
          description: scenario.description || '',
        });
        setWorkflowGraph(scenario.workflowGraph || getInitialWorkflow());
      } else {
        form.resetFields();
        setWorkflowGraph(getInitialWorkflow());
      }
    }
  }, [visible, scenario, form]);

  const getInitialWorkflow = () => {
    return {
      nodes: [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 100, y: 100 },
          data: {
            label: intl.get('触发器'),
            triggerType: 'time',
            config: {},
          },
        },
      ],
      edges: [],
    };
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);

      // Get workflow data from editor
      const currentWorkflow = editorRef.current?.getData();

      const endpoint = scenario ? '/api/scenarios' : '/api/scenarios';
      const method = scenario ? 'put' : 'post';
      const payload = {
        ...values,
        workflowGraph: currentWorkflow || workflowGraph,
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

  const handleWorkflowChange = (newWorkflow: any) => {
    setWorkflowGraph(newWorkflow);
  };

  return (
    <Modal
      title={scenario ? intl.get('编辑场景') : intl.get('新建场景')}
      open={visible}
      onCancel={onCancel}
      onOk={handleSubmit}
      confirmLoading={loading}
      width={1200}
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
          <div
            style={{
              border: '1px solid #d9d9d9',
              borderRadius: 4,
              height: 500,
              overflow: 'hidden',
            }}
          >
            <FreeLayoutEditor
              ref={editorRef}
              data={workflowGraph}
              onChange={handleWorkflowChange}
              nodeTypes={{
                trigger: {
                  render: (node: any) => (
                    <div
                      style={{
                        padding: 10,
                        background: '#1890ff',
                        color: 'white',
                        borderRadius: 4,
                        minWidth: 150,
                      }}
                    >
                      <div>{node.data.label}</div>
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        {node.data.triggerType}
                      </div>
                    </div>
                  ),
                },
                condition: {
                  render: (node: any) => (
                    <div
                      style={{
                        padding: 10,
                        background: '#52c41a',
                        color: 'white',
                        borderRadius: 4,
                        minWidth: 150,
                      }}
                    >
                      <div>{node.data.label}</div>
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        {node.data.operator}
                      </div>
                    </div>
                  ),
                },
                action: {
                  render: (node: any) => (
                    <div
                      style={{
                        padding: 10,
                        background: '#fa8c16',
                        color: 'white',
                        borderRadius: 4,
                        minWidth: 150,
                      }}
                    >
                      <div>{node.data.label}</div>
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        {node.data.actionType}
                      </div>
                    </div>
                  ),
                },
              }}
            />
          </div>
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ScenarioModal;
