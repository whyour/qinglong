import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Statistic, Button } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const ViewCreateModal = ({
  view,
  handleCancel,
  visible,
}: {
  view?: any;
  visible: boolean;
  handleCancel: (param?: string) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const { value, name } = values;
    const method = view ? 'put' : 'post';
    let payload;
    if (!view) {
      payload = [{ value, name }];
    } else {
      payload = { ...values, id: view.id };
    }
    try {
      const { code, data } = await request[method](
        `${config.apiPrefix}crons/views`,
        {
          data: payload,
        },
      );
      if (code !== 200) {
        message.error(data);
      }
      setLoading(false);
      handleCancel(data);
    } catch (error: any) {
      setLoading(false);
    }
  };

  useEffect(() => {
    form.resetFields();
  }, [view, visible]);

  return (
    <Modal
      title={view ? '编辑视图' : '新建视图'}
      visible={visible}
      forceRender
      centered
      maskClosable={false}
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
      <Form form={form} layout="vertical" name="env_modal" initialValues={view}>
        <Form.Item
          name="name"
          label="视图名称"
          rules={[{ required: true, message: '请输入视图名称' }]}
        >
          <Input placeholder="请输入视图名称" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ViewCreateModal;
