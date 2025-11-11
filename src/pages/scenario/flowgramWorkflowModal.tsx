import React, { useState, useEffect } from 'react';
import { Modal, Form, Input, Switch, message } from 'antd';
import FlowgramEditor from './flowgram/Editor';
import type { FlowgramGraph } from './flowgram/types';

interface FlowgramWorkflowModalProps {
  visible: boolean;
  scenario?: any;
  onCancel: () => void;
  onOk: (values: any) => void;
}

const FlowgramWorkflowModal: React.FC<FlowgramWorkflowModalProps> = ({
  visible,
  scenario,
  onCancel,
  onOk,
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [workflowGraph, setWorkflowGraph] = useState<FlowgramGraph | undefined>();

  useEffect(() => {
    if (visible && scenario) {
      form.setFieldsValue({
        name: scenario.name,
        isDisabled: scenario.isDisabled === 1,
      });
      if (scenario.workflowGraph) {
        setWorkflowGraph(scenario.workflowGraph);
      }
    } else if (visible) {
      form.resetFields();
      setWorkflowGraph(undefined);
    }
  }, [visible, scenario, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      
      // Validate workflow has nodes
      if (!workflowGraph || workflowGraph.nodes.length === 0) {
        message.error('请添加至少一个节点到工作流');
        return;
      }

      setLoading(true);

      const submitData = {
        ...values,
        workflowGraph,
        isDisabled: values.isDisabled ? 1 : 0,
      };

      if (scenario) {
        submitData.id = scenario.id;
      }

      await onOk(submitData);
      form.resetFields();
      setWorkflowGraph(undefined);
    } catch (error) {
      console.error('表单验证失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    form.resetFields();
    setWorkflowGraph(undefined);
    onCancel();
  };

  return (
    <Modal
      title={scenario ? '编辑场景' : '新建场景'}
      open={visible}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={loading}
      width={1400}
      style={{ top: 20 }}
      bodyStyle={{ height: '80vh', overflow: 'auto' }}
      maskClosable={false}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="场景名称"
          rules={[{ required: true, message: '请输入场景名称' }]}
        >
          <Input placeholder="输入场景名称" />
        </Form.Item>

        <Form.Item name="isDisabled" label="启用状态" valuePropName="checked">
          <Switch checkedChildren="启用" unCheckedChildren="禁用" />
        </Form.Item>

        <Form.Item label="工作流设计">
          <FlowgramEditor value={workflowGraph} onChange={setWorkflowGraph} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default FlowgramWorkflowModal;
