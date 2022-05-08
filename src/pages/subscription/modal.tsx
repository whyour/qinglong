import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Button } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import cron_parser from 'cron-parser';
import EditableTagGroup from '@/components/tag';

const SubscriptionModal = ({
  subscription,
  handleCancel,
  visible,
}: {
  subscription?: any;
  visible: boolean;
  handleCancel: (needUpdate?: boolean) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const method = subscription ? 'put' : 'post';
    const payload = { ...values };
    if (subscription) {
      payload.id = subscription.id;
    }
    try {
      const { code, data } = await request[method](
        `${config.apiPrefix}subscriptions`,
        {
          data: payload,
        },
      );
      if (code === 200) {
        message.success(
          subscription ? '更新Subscription成功' : '新建Subscription成功',
        );
      } else {
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
  }, [subscription, visible]);

  return (
    <Modal
      title={subscription ? '编辑订阅' : '新建订阅'}
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
      <Form
        form={form}
        layout="vertical"
        name="form_in_modal"
        initialValues={subscription}
      >
        <Form.Item name="name" label="名称">
          <Input placeholder="请输入订阅名称" />
        </Form.Item>
        <Form.Item
          name="command"
          label="命令"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input.TextArea
            rows={4}
            autoSize={true}
            placeholder="请输入要执行的命令"
          />
        </Form.Item>
        <Form.Item
          name="schedule"
          label="定时规则"
          rules={[
            { required: true },
            {
              validator: (rule, value) => {
                if (!value || cron_parser.parseExpression(value).hasNext()) {
                  return Promise.resolve();
                } else {
                  return Promise.reject('Subscription表达式格式有误');
                }
              },
            },
          ]}
        >
          <Input placeholder="秒(可选) 分 时 天 月 周" />
        </Form.Item>
        <Form.Item name="labels" label="标签">
          <EditableTagGroup />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SubscriptionModal;
