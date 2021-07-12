import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const EnvModal = ({
  env,
  handleCancel,
  visible,
}: {
  env?: any;
  visible: boolean;
  handleCancel: (cks?: any[]) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const method = env ? 'put' : 'post';
    const payload = env ? { ...values, _id: env._id } : values;
    const { code, data } = await request[method](`${config.apiPrefix}envs`, {
      data: payload,
    });
    if (code === 200) {
      message.success(env ? '更新变量成功' : '添加变量成功');
    } else {
      message.error(data);
    }
    setLoading(false);
    handleCancel(data);
  };

  useEffect(() => {
    form.resetFields();
  }, [env, visible]);

  return (
    <Modal
      title={env ? '编辑变量' : '新建变量'}
      visible={visible}
      forceRender
      onOk={() => {
        form
          .validateFields()
          .then((values) => {
            handleOk(values);
          })
          .catch((info) => {
            console.log('Validate Failed:', info);
          });
      }}
      onCancel={() => handleCancel()}
      confirmLoading={loading}
    >
      <Form form={form} layout="vertical" name="env_modal" initialValues={env}>
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '请输入环境变量名称' }]}
        >
          <Input placeholder="请输入环境变量名称" />
        </Form.Item>
        <Form.Item
          name="value"
          label="值"
          rules={[{ required: true, message: '请输入环境变量值' }]}
        >
          <Input.TextArea
            rows={4}
            autoSize={true}
            placeholder="请输入环境变量值"
          />
        </Form.Item>
        <Form.Item name="remarks" label="备注">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default EnvModal;
