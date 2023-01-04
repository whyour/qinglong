import React, { useCallback, useEffect, useState } from 'react';
import { Modal, message, InputNumber, Form, Radio, Select, Input } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import cron_parser from 'cron-parser';

const { Option } = Select;
const repoUrlRegx = /[^\/\:]+\/[^\/]+(?=\.git)/;
const fileUrlRegx = /[^\/\:]+\/[^\/]+$/;

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
        message.success(subscription ? '更新订阅成功' : '新建订阅成功');
        handleCancel(data);
      }
      setLoading(false);
    } catch (error: any) {
      setLoading(false);
    }
  };

  const typeChange = (e) => {
    setType(e.target.value);
    const _url = form.getFieldValue('url');
    const _branch = form.getFieldValue('branch');
    form.setFieldsValue({
      alias: formatAlias(_url, _branch, e.target.value),
    });
    if (_url) {
      form.validateFields(['url']);
    }
  };

  const scheduleTypeChange = (e) => {
    setScheduleType(e.target.value);
    form.setFieldsValue({ schedule: '' });
  };

  const pullTypeChange = (e) => {
    setPullType(e.target.value);
  };

  const onUrlChange = (e) => {
    const _branch = form.getFieldValue('branch');
    form.setFieldsValue({
      alias: formatAlias(e.target.value, _branch),
    });
  };

  const onBranchChange = (e) => {
    const _url = form.getFieldValue('url');
    form.setFieldsValue({
      alias: formatAlias(_url, e.target.value),
    });
  };

  const formatAlias = (_url: string, _branch: string, _type = type) => {
    let _alias = '';
    const _regx = _type === 'file' ? fileUrlRegx : repoUrlRegx;
    if (_regx.test(_url)) {
      _alias = _url.match(_regx)![0].replaceAll('/', '_').replaceAll('.', '_');
    }
    if (_branch) {
      _alias = _alias + '_' + _branch;
    }
    return _alias;
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
    const intervalTypeChange = (type: string) => {
      setIntervalType(type);
      if (intervalNumber && intervalNumber > 0) {
        onChange?.({ type, value: intervalNumber });
      }
    };

    const numberChange = (value: number) => {
      setIntervalNumber(value);
      if (!value) {
        onChange?.(null);
      } else {
        onChange?.({ type: intervalType, value });
      }
    };

    useEffect(() => {
      if (value) {
        setIntervalType(value.type);
        setIntervalNumber(value.value);
      }
    }, [value]);
    return (
      <Input.Group compact>
        <InputNumber
          addonBefore="每"
          precision={0}
          min={1}
          value={intervalNumber}
          style={{ width: 'calc(100% - 58px)' }}
          onChange={numberChange}
        />
        <Select value={intervalType} onChange={intervalTypeChange}>
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
      <Form.Item
        name={['pull_option', 'private_key']}
        label="私钥"
        rules={[{ required: true }]}
      >
        <Input.TextArea
          rows={4}
          autoSize={{ minRows: 1, maxRows: 6 }}
          placeholder="请输入私钥"
        />
      </Form.Item>
    ) : (
      <>
        <Form.Item
          name={['pull_option', 'username']}
          label="用户名"
          rules={[{ required: true }]}
        >
          <Input placeholder="请输入认证用户名" />
        </Form.Item>
        <Form.Item
          name={['pull_option', 'password']}
          tooltip="Github已不支持密码认证，请使用Token方式"
          label="密码/Token"
          rules={[{ required: true }]}
        >
          <Input placeholder="请输入密码或者Token" />
        </Form.Item>
      </>
    );
  };

  const onPaste = useCallback((e: any) => {
    const text = e.clipboardData.getData('text') as string;
    if (text.startsWith('ql ')) {
      const [
        ,
        type,
        url,
        whitelist,
        blacklist,
        dependences,
        branch,
        extensions,
      ] = text
        .split(' ')
        .map((x) => x.trim().replace(/\"/g, '').replace(/\'/, ''));
      const _type =
        type === 'raw'
          ? 'file'
          : url.startsWith('http')
          ? 'public-repo'
          : 'private-repo';

      form.setFieldsValue({
        type: _type,
        url,
        whitelist,
        blacklist,
        dependences,
        branch,
        extensions,
        alias: formatAlias(url, branch),
      });
      setType(_type);
    }
  }, []);

  const onNamePaste = useCallback((e) => {
    const text = e.clipboardData.getData('text') as string;
    if (text.startsWith('ql ')) {
      e.preventDefault();
    }
  }, []);

  useEffect(() => {
    if (visible) {
      window.addEventListener('paste', onPaste);
    } else {
      window.removeEventListener('paste', onPaste);
    }
  }, [visible]);

  useEffect(() => {
    form.setFieldsValue(subscription || {});
    setType((subscription && subscription.type) || 'public-repo');
    setScheduleType((subscription && subscription.schedule_type) || 'crontab');
    setPullType((subscription && subscription.pull_type) || 'ssh-key');
    if (!subscription) {
      form.resetFields();
    }
  }, [subscription, visible]);

  return (
    <Modal
      title={subscription ? '编辑订阅' : '新建订阅'}
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
      <Form form={form} name="form_in_modal" layout="vertical">
        <Form.Item name="name" label="名称">
          <Input
            placeholder="支持拷贝ql repo/raw命令，粘贴导入"
            onPaste={onNamePaste}
          />
        </Form.Item>
        <Form.Item
          name="type"
          label="类型"
          rules={[{ required: true }]}
          initialValue={'public-repo'}
        >
          <Radio.Group onChange={typeChange}>
            <Radio value="public-repo">公开仓库</Radio>
            <Radio value="private-repo">私有仓库</Radio>
            <Radio value="file">单文件</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item
          name="url"
          label="链接"
          rules={[
            { required: true },
            { pattern: type === 'file' ? fileUrlRegx : repoUrlRegx },
          ]}
        >
          <Input.TextArea
            rows={4}
            autoSize={true}
            placeholder="请输入订阅链接"
            onPaste={onUrlChange}
            onChange={onUrlChange}
          />
        </Form.Item>
        {type !== 'file' && (
          <Form.Item name="branch" label="分支">
            <Input
              placeholder="请输入分支"
              onPaste={onBranchChange}
              onChange={onBranchChange}
            />
          </Form.Item>
        )}
        <Form.Item
          name="alias"
          label="唯一值"
          rules={[{ required: true, message: '' }]}
          tooltip="唯一值用于日志目录和私钥别名"
        >
          <Input placeholder="自动生成" disabled />
        </Form.Item>
        {type === 'private-repo' && (
          <>
            <Form.Item
              name="pull_type"
              label="拉取方式"
              initialValue={'ssh-key'}
              rules={[{ required: true }]}
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
          name="schedule_type"
          label="定时类型"
          initialValue={'crontab'}
          rules={[{ required: true }]}
        >
          <Radio.Group onChange={scheduleTypeChange}>
            <Radio value="crontab">crontab</Radio>
            <Radio value="interval">interval</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item
          name={scheduleType === 'crontab' ? 'schedule' : 'interval_schedule'}
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
        {type !== 'file' && (
          <>
            <Form.Item
              name="whitelist"
              label="白名单"
              tooltip="多个关键词竖线分割，支持正则表达式"
            >
              <Input.TextArea
                rows={4}
                autoSize={true}
                placeholder="请输入脚本筛选白名单关键词，多个关键词竖线分割"
              />
            </Form.Item>
            <Form.Item
              name="blacklist"
              label="黑名单"
              tooltip="多个关键词竖线分割，支持正则表达式"
            >
              <Input.TextArea
                rows={4}
                autoSize={true}
                placeholder="请输入脚本筛选黑名单关键词，多个关键词竖线分割"
              />
            </Form.Item>
            <Form.Item
              name="dependences"
              label="依赖文件"
              tooltip="多个关键词竖线分割，支持正则表达式"
            >
              <Input.TextArea
                rows={4}
                autoSize={true}
                placeholder="请输入脚本依赖文件关键词，多个关键词竖线分割"
              />
            </Form.Item>
            <Form.Item
              name="extensions"
              label="文件后缀"
              tooltip="仓库需要拉取的文件后缀，多个后缀空格分隔，默认使用配置文件中的RepoFileExtensions"
            >
              <Input placeholder="请输入文件后缀" />
            </Form.Item>
            <Form.Item
              name="sub_before"
              label="执行前"
              tooltip="运行订阅前执行的命令，比如 cp/mv/python3 xxx.py/node xxx.js"
            >
              <Input.TextArea
                rows={4}
                autoSize={true}
                placeholder="请输入运行订阅前要执行的命令"
              />
            </Form.Item>
            <Form.Item
              name="sub_after"
              label="执行后"
              tooltip="运行订阅后执行的命令，比如 cp/mv/python3 xxx.py/node xxx.js"
            >
              <Input.TextArea
                rows={4}
                autoSize={true}
                placeholder="请输入运行订阅后要执行的命令"
              />
            </Form.Item>
          </>
        )}
        <Form.Item
          name="proxy"
          label="代理"
          tooltip="公开仓库支持HTTP/SOCK5代理，私有仓库支持SOCK5代理"
        >
          <Input
            placeholder={
              type === 'private-repo'
                ? 'SOCK5代理，例如 IP:PORT'
                : 'HTTP/SOCK5代理，例如 http://127.0.0.1:1080'
            }
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SubscriptionModal;
