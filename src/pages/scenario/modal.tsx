import React, { useEffect } from 'react';
import { Modal, Form, Input, message } from 'antd';
import intl from 'react-intl-universal';
import { Scenario } from './type';

interface ScenarioModalProps {
  visible: boolean;
  scenario?: Scenario;
  onOk: (values: Scenario) => void;
  onCancel: () => void;
}

const { TextArea } = Input;

const ScenarioModal: React.FC<ScenarioModalProps> = ({
  visible,
  scenario,
  onOk,
  onCancel,
}) => {
  const [form] = Form.useForm();

  useEffect(() => {
    if (visible && scenario) {
      form.setFieldsValue({
        name: scenario.name,
        description: scenario.description,
      });
    } else if (visible) {
      form.resetFields();
    }
  }, [visible, scenario, form]);

  const handleOk = () => {
    form
      .validateFields()
      .then((values) => {
        onOk({
          ...scenario,
          ...values,
        });
        form.resetFields();
      })
      .catch((info) => {
        console.log('Validate Failed:', info);
      });
  };

  return (
    <Modal
      title={scenario ? intl.get('编辑场景') : intl.get('新建场景')}
      open={visible}
      onOk={handleOk}
      onCancel={onCancel}
      okText={intl.get('确认')}
      cancelText={intl.get('取消')}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label={intl.get('场景名称')}
          rules={[
            {
              required: true,
              message: intl.get('请输入场景名称'),
            },
          ]}
        >
          <Input placeholder={intl.get('请输入场景名称')} />
        </Form.Item>

        <Form.Item
          name="description"
          label={intl.get('场景描述')}
        >
          <TextArea
            rows={4}
            placeholder={intl.get('请输入场景描述')}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ScenarioModal;
