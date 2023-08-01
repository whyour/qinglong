import intl from 'react-intl-universal';
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
      const { code, data } = await request[method](
        `${config.apiPrefix}apps`,
        payload,
      );

      if (code === 200) {
        message.success(
          app ? intl.get('更新应用成功') : intl.get('创建应用成功'),
        );
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
      title={app ? intl.get('编辑应用') : intl.get('创建应用')}
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
          label={intl.get('名称')}
          rules={[
            {
              validator: (_, value) =>
                ['system'].includes(value)
                  ? Promise.reject(new Error(intl.get('名称不能为保留关键字')))
                  : Promise.resolve(),
            },
          ]}
        >
          <Input placeholder={intl.get('请输入应用名称')} />
        </Form.Item>
        <Form.Item
          name="scopes"
          label={intl.get('权限')}
          rules={[{ required: true }]}
        >
          <Select
            mode="multiple"
            placeholder={intl.get('请选择模块权限')}
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
