import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Button } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import cronParse from 'cron-parser';
import EditableTagGroup from '@/components/tag';

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
      payload.id = cron.id;
    }
    try {
      const { code, data } = await request[method](`${config.apiPrefix}crons`, {
        data: payload,
      });

      if (code === 200) {
        message.success(cron ? '更新Cron成功' : '新建Cron成功');
        handleCancel(data);
      }
      setLoading(false);
    } catch (error: any) {
      setLoading(false);
    }
  };

  useEffect(() => {
    form.resetFields();
  }, [cron, visible]);

  return (
    <Modal
      title={cron ? '编辑任务' : '新建任务'}
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
        name="form_in_modal"
        initialValues={cron}
      >
        <Form.Item name="name" label="名称">
          <Input placeholder="请输入任务名称" />
        </Form.Item>
        <Form.Item
          name="command"
          label="命令/脚本"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input.TextArea
            rows={4}
            autoSize={true}
            placeholder="支持输入脚本路径/任意系统可执行命令/task 脚本路径"
          />
        </Form.Item>
        <Form.Item
          name="schedule"
          label="定时规则"
          rules={[
            { required: true },
            {
              validator: (rule, value) => {
                if (!value || cronParse.parseExpression(value).hasNext()) {
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
        <Form.Item name="labels" label="标签">
          <EditableTagGroup />
        </Form.Item>
      </Form>
    </Modal>
  );
};

const CronLabelModal = ({
  ids,
  handleCancel,
  visible,
}: {
  ids: Array<string>;
  visible: boolean;
  handleCancel: (needUpdate?: boolean) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const update = async (action: 'delete' | 'post') => {
    form
      .validateFields()
      .then(async (values) => {
        setLoading(true);
        const payload = { ids, labels: values.labels };
        try {
          const { code, data } = await request[action](
            `${config.apiPrefix}crons/labels`,
            {
              data: payload,
            },
          );

          if (code === 200) {
            message.success(
              action === 'post' ? '添加Labels成功' : '删除Labels成功',
            );
            handleCancel(true);
          }
          setLoading(false);
        } catch (error) {
          setLoading(false);
        }
      })
      .catch((info) => {
        console.log('Validate Failed:', info);
      });
  };

  useEffect(() => {
    form.resetFields();
  }, [ids, visible]);

  const buttons = [
    <Button onClick={() => handleCancel(false)}>取消</Button>,
    <Button type="primary" danger onClick={() => update('delete')}>
      删除
    </Button>,
    <Button type="primary" onClick={() => update('post')}>
      添加
    </Button>,
  ];

  return (
    <Modal
      title="批量修改标签"
      open={visible}
      footer={buttons}
      centered
      maskClosable={false}
      forceRender
      onCancel={() => handleCancel(false)}
      confirmLoading={loading}
    >
      <Form form={form} layout="vertical" name="form_in_label_modal">
        <Form.Item name="labels" label="标签">
          <EditableTagGroup />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export { CronModal as default, CronLabelModal };
