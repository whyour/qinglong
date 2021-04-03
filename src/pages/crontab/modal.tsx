import React, { useEffect, useState } from 'react';
import { Modal, notification, Input, Form } from 'antd';
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

  const handleOk = async (values: any) => {
    const method = cron ? 'put' : 'post';
    const payload = { ...values };
    if (cron) {
      payload._id = cron._id;
    }
    const { code, data } = await request[method](`${config.apiPrefix}crons`, {
      data: payload,
    });
    if (code === 200) {
      notification.success({
        message: cron ? '更新Cron成功' : '添加Cron成功',
      });
    } else {
      notification.error({
        message: data,
      });
    }
    handleCancel(true);
  };

  useEffect(() => {
    if (cron) {
      form.setFieldsValue(cron);
    }
  }, [cron]);

  return (
    <Modal
      title={cron ? '编辑定时' : '新建定时'}
      visible={visible}
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
      destroyOnClose
    >
      <Form form={form} layout="vertical" name="form_in_modal" preserve={false}>
        <Form.Item name="name" label="名称">
          <Input />
        </Form.Item>
        <Form.Item name="command" label="任务" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item
          name="schedule"
          label="时间"
          rules={[
            { required: true },
            {
              validator: (rule, value) => {
                if (cronParse.parseString(value).expressions.length > 0) {
                  return Promise.resolve();
                } else {
                  return Promise.reject('Cron表达式格式有误');
                }
              },
            },
          ]}
        >
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default CronModal;
