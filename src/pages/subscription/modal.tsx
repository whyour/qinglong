import React, { useEffect, useState } from 'react';
import { Modal, message, InputNumber, Form, Radio, Select, Input } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import cron_parser from 'cron-parser';
import EditableTagGroup from '@/components/tag';

const { Option } = Select;
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
  const [type, setType] = useState('public-repo');
  const [scheduleType, setScheduleType] = useState('crontab');
  const [pullType, setPullType] = useState<'ssh-key' | 'user-pwd'>('ssh-key');

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

  const typeChange = (e) => {
    setType(e.target.value);
  };

  const scheduleTypeChange = (e) => {
    setScheduleType(e.target.value);
    form.setFieldsValue({ schedule: '' });
  };

  const pullTypeChange = (e) => {
    setPullType(e.target.value);
  };

  const IntervalSelect = ({
    value,
    onChange,
  }: {
    value?: any;
    onChange?: (param: any) => void;
  }) => {
    const [intervalType, setIntervalType] = useState('days');
    const [intervalNumber, setIntervalNumber] = useState<number>();
    const intervalTypeChange = (e) => {
      setIntervalType(e.target.value);
      onChange?.({ [e.target.value]: intervalNumber });
    };

    const numberChange = (value: number) => {
      setIntervalNumber(value);
      onChange?.({ [intervalType]: value });
    };

    useEffect(() => {
      if (value) {
        const key = Object.keys(value)[0];
        if (key) {
          setIntervalType(key);
          setIntervalNumber(value[key]);
        }
      }
    }, [value]);
    return (
      <Input.Group compact>
        <InputNumber
          addonBefore="每"
          precision={0}
          min={1}
          defaultValue={intervalNumber}
          style={{ width: 'calc(100% - 58px)' }}
          onChange={numberChange}
        />
        <Select defaultValue={intervalType} onChange={intervalTypeChange}>
          <Option value="days">天</Option>
          <Option value="hours">时</Option>
          <Option value="minutes">分</Option>
          <Option value="seconds">秒</Option>
        </Select>
      </Input.Group>
    );
  };
  const PullOptions = ({
    value,
    onChange,
    type,
  }: {
    value?: any;
    type: 'ssh-key' | 'user-pwd';
    onChange?: (param: any) => void;
  }) => {
    return type === 'ssh-key' ? (
      <Form.Item name="private_key" label="私钥" rules={[{ required: true }]}>
        <Input.TextArea rows={4} autoSize={true} placeholder="请输入私钥" />
      </Form.Item>
    ) : (
      <>
        <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
          <Input placeholder="请输入认证用户名" />
        </Form.Item>
        <Form.Item
          name="password"
          tooltip="Github已不支持密码认证，请使用Token方式"
          label="密码/Token"
          rules={[{ required: true }]}
        >
          <Input placeholder="请输入密码或者Token" />
        </Form.Item>
      </>
    );
  };

  useEffect(() => {
    form.resetFields();
  }, [subscription, visible]);

  return (
    <Modal
      title={subscription ? '编辑订阅' : '新建订阅'}
      visible={visible}
      forceRender
      centered
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
        name="form_in_modal"
        initialValues={subscription}
        layout="vertical"
      >
        <Form.Item name="name" label="别名">
          <Input placeholder="请输入订阅别名" />
        </Form.Item>
        <Form.Item name="url" label="链接" rules={[{ required: true }]}>
          <Input placeholder="请输入订阅链接" />
        </Form.Item>
        <Form.Item
          name="schedule_type"
          label="定时类型"
          initialValue={'crontab'}
        >
          <Radio.Group onChange={scheduleTypeChange}>
            <Radio value="crontab">crontab</Radio>
            <Radio value="interval">interval</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item
          name="schedule"
          label="定时规则"
          rules={[
            { required: true },
            {
              validator: (rule, value) => {
                if (
                  scheduleType === 'interval' ||
                  !value ||
                  cron_parser.parseExpression(value).hasNext()
                ) {
                  return Promise.resolve();
                } else {
                  return Promise.reject('Subscription表达式格式有误');
                }
              },
            },
          ]}
        >
          {scheduleType === 'interval' ? (
            <IntervalSelect />
          ) : (
            <Input placeholder="秒(可选) 分 时 天 月 周" />
          )}
        </Form.Item>
        <Form.Item name="type" label="类型" initialValue={'public-repo'}>
          <Radio.Group onChange={typeChange}>
            <Radio value="public-repo">公开仓库</Radio>
            <Radio value="private-repo">私有仓库</Radio>
            <Radio value="file">单个文件</Radio>
          </Radio.Group>
        </Form.Item>
        {type !== 'file' && (
          <>
            <Form.Item
              name="command"
              label="白名单"
              rules={[{ whitespace: true }]}
              tooltip="多个关键词竖线分割，支持正则表达式"
            >
              <Input.TextArea
                rows={4}
                autoSize={true}
                placeholder="请输入脚本筛选白名单关键词，多个关键词竖线分割"
              />
            </Form.Item>
            <Form.Item
              name="command"
              label="黑名单"
              rules={[{ whitespace: true }]}
              tooltip="多个关键词竖线分割，支持正则表达式"
            >
              <Input.TextArea
                rows={4}
                autoSize={true}
                placeholder="请输入脚本筛选黑名单关键词，多个关键词竖线分割"
              />
            </Form.Item>
            <Form.Item
              name="command"
              label="依赖文件"
              rules={[{ whitespace: true }]}
              tooltip="多个关键词竖线分割，支持正则表达式"
            >
              <Input.TextArea
                rows={4}
                autoSize={true}
                placeholder="请输入脚本依赖文件关键词，多个关键词竖线分割"
              />
            </Form.Item>
            {type === 'private-repo' && (
              <>
                <Form.Item
                  name="pull_type"
                  label="拉取方式"
                  initialValue={'ssh-key'}
                >
                  <Radio.Group onChange={pullTypeChange}>
                    <Radio value="ssh-key">私钥</Radio>
                    <Radio value="user-pwd">用户名密码/Token</Radio>
                  </Radio.Group>
                </Form.Item>
                <PullOptions type={pullType} />
              </>
            )}
            <Form.Item
              name="alias"
              label="唯一值"
              rules={[{ required: true }]}
              tooltip="唯一值用于日志目录和私钥别名"
            >
              <Input placeholder="自动生成" disabled />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
};

export default SubscriptionModal;
