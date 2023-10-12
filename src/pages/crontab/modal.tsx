import intl from 'react-intl-universal';
import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Button, Space } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import cronParse from 'cron-parser';
import EditableTagGroup from '@/components/tag';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';

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
      const { code, data } = await request[method](
        `${config.apiPrefix}crons`,
        payload,
      );

      if (code === 200) {
        message.success(
          cron ? intl.get('更新任务成功') : intl.get('创建任务成功'),
        );
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
      title={cron ? intl.get('编辑任务') : intl.get('创建任务')}
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
        <Form.Item
          name="name"
          label={intl.get('名称')}
          rules={[{ required: true, whitespace: true }]}
        >
          <Input placeholder={intl.get('请输入任务名称')} />
        </Form.Item>
        <Form.Item
          name="command"
          label={intl.get('命令/脚本')}
          rules={[{ required: true, whitespace: true }]}
        >
          <Input.TextArea
            rows={4}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={intl.get(
              '支持输入脚本路径/任意系统可执行命令/task 脚本路径',
            )}
          />
        </Form.Item>
        <Form.Item
          name="schedule"
          label={intl.get('定时规则')}
          rules={[
            { required: true },
            {
              validator: (rule, value) => {
                if (!value || cronParse.parseExpression(value).hasNext()) {
                  return Promise.resolve();
                } else {
                  return Promise.reject(intl.get('Cron表达式格式有误'));
                }
              },
            },
          ]}
        >
          <Input placeholder={intl.get('秒(可选) 分 时 天 月 周')} />
        </Form.Item>
        <Form.List name="extra_schedules">
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map(({ key, name, ...restField }) => (
                <Form.Item key={key} noStyle>
                  <Space className="view-create-modal-sorts" align="baseline">
                    <Form.Item
                      {...restField}
                      name={[name, 'schedule']}
                      rules={[{ required: true }]}
                    >
                      <Input
                        placeholder={intl.get('秒(可选) 分 时 天 月 周')}
                      />
                    </Form.Item>
                    <MinusCircleOutlined
                      className="dynamic-delete-button"
                      onClick={() => remove(name)}
                    />
                  </Space>
                </Form.Item>
              ))}
              <Form.Item>
                <a onClick={() => add({ schedule: '' })}>
                  <PlusOutlined />
                  {intl.get('新增定时规则')}
                </a>
              </Form.Item>
              <Form.ErrorList errors={errors} />
            </>
          )}
        </Form.List>
        <Form.Item name="labels" label={intl.get('标签')}>
          <EditableTagGroup />
        </Form.Item>
        <Form.Item
          name="task_before"
          label={intl.get('执行前')}
          tooltip={intl.get(
            '运行任务前执行的命令，比如 cp/mv/python3 xxx.py/node xxx.js',
          )}
          rules={[
            {
              validator(rule, value) {
                if (
                  value &&
                  (value.includes(' task ') || value.startsWith('task '))
                ) {
                  return Promise.reject(intl.get('不能包含 task 命令'));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Input.TextArea
            rows={4}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={intl.get(
              '请输入运行任务前要执行的命令，不能包含 task 命令',
            )}
          />
        </Form.Item>
        <Form.Item
          name="task_after"
          label={intl.get('执行后')}
          tooltip={intl.get(
            '运行任务后执行的命令，比如 cp/mv/python3 xxx.py/node xxx.js',
          )}
          rules={[
            {
              validator(rule, value) {
                if (
                  value &&
                  (value.includes(' task ') || value.startsWith('task '))
                ) {
                  return Promise.reject(intl.get('不能包含 task 命令'));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Input.TextArea
            rows={4}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={intl.get(
              '请输入运行任务后要执行的命令，不能包含 task 命令',
            )}
          />
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
            payload,
          );

          if (code === 200) {
            message.success(
              action === 'post'
                ? intl.get('添加Labels成功')
                : intl.get('删除Labels成功'),
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
    <Button onClick={() => handleCancel(false)}>{intl.get('取消')}</Button>,
    <Button type="primary" danger onClick={() => update('delete')}>
      {intl.get('删除')}
    </Button>,
    <Button type="primary" onClick={() => update('post')}>
      {intl.get('添加')}
    </Button>,
  ];

  return (
    <Modal
      title={intl.get('批量修改标签')}
      open={visible}
      footer={buttons}
      centered
      maskClosable={false}
      forceRender
      onCancel={() => handleCancel(false)}
      confirmLoading={loading}
    >
      <Form form={form} layout="vertical" name="form_in_label_modal">
        <Form.Item name="labels" label={intl.get('标签')}>
          <EditableTagGroup />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export { CronModal as default, CronLabelModal };
