import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Select } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const AppModal = ({
  app,
  handleCancel,
  visible,
}: {
  app?: any;
  visible: boolean;
  handleCancel: (needUpdate?: boolean) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const method = app ? 'put' : 'post';
    const payload = { ...values };
    if (app) {
      payload.id = app.id;
    }
    try {
      const { code, data } = await request[method](`${config.apiPrefix}apps`, {
        data: payload,
      });

      if (code === 200) {
        message.success(app ? '更新应用成功' : '新建应用成功');
        handleCancel(data);
      }
      setLoading(false);
    } catch (error) {
      setLoading(false);
    }
  };

  useEffect(() => {
    form.resetFields();
  }, [app, visible]);

  return (
    <Modal
      title={app ? '编辑应用' : '新建应用'}
      open={visible}
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
      <Form
        form={form}
        layout="vertical"
        name="form_app_modal"
        initialValues={app}
      >
        <Form.Item
          name="name"
          label="名称"
          rules={[
            {
              validator: (_, value) =>
                ['system'].includes(value)
                  ? Promise.reject(new Error('名称不能为保留关键字'))
                  : Promise.resolve(),
            },
          ]}
        >
          <Input placeholder="请输入应用名称" />
        </Form.Item>
        <Form.Item name="scopes" label="权限" rules={[{ required: true }]}>
          <Select
            mode="multiple"
            placeholder="请选择模块权限"
            allowClear
            style={{ width: '100%' }}
          >
            {config.scopes.map((x) => {
              return (
                <Select.Option key={x.value} value={x.value}>
                  {x.name}
                </Select.Option>
              );
            })}
          </Select>
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default AppModal;
