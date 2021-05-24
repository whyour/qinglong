import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import cronParse from 'cron-parser';

const CronModal = ({
  cron,
  handleCancel,
  visible,
}: {
  cron?: any;
  visible: boolean;
  handleCancel: (needUpdate?: boolean) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const method = cron ? 'put' : 'post';
    const payload = { ...values };
    if (cron) {
      payload._id = cron._id;
    }
    const { code, data } = await request[method](`${config.apiPrefix}crons`, {
      data: payload,
    });
    if (code === 200) {
      message.success(cron ? '更新Cron成功' : '添加Cron成功');
    } else {
      message.error(data);
    }
    setLoading(false);
    handleCancel(data);
  };

  useEffect(() => {
    if (cron) {
      form.setFieldsValue(cron);
    } else {
      form.resetFields();
    }
  }, [cron]);

  return (
    <Modal
      title={cron ? '编辑定时' : '新建定时'}
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
      destroyOnClose
    >
      <Form form={form} layout="vertical" name="form_in_modal" preserve={false}>
        <Form.Item name="name" label="名称">
          <Input placeholder="请输入任务名称" />
        </Form.Item>
        <Form.Item name="command" label="命令" rules={[{ required: true }]}>
          <Input placeholder="请输入要执行的命令" />
        </Form.Item>
        <Form.Item
          name="schedule"
          label="定时规则"
          rules={[
            { required: true },
            {
              validator: (rule, value) => {
                if (cronParse.parseExpression(value).hasNext()) {
                  return Promise.resolve();
                } else {
                  return Promise.reject('Cron表达式格式有误');
                }
              },
            },
          ]}
        >
          <Input placeholder="秒(可选) 分 时 天 月 周" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default CronModal;
