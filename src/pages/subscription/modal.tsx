import intl from 'react-intl-universal';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  message,
  InputNumber,
  Form,
  Radio,
  Select,
  Input,
  Switch,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import cron_parser from 'cron-parser';
import isNil from 'lodash/isNil';

const { Option } = Select;
const repoUrlRegx = /([^\/\:]+\/[^\/]+)(?=\.git)/;
const fileUrlRegx = /([^\/\:]+\/[^\/\.]+)\.[a-z]+$/;

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
    const payload = {
      ...values,
      autoAddCron: Boolean(values.autoAddCron),
      autoDelCron: Boolean(values.autoDelCron),
    };
    if (subscription) {
      payload.id = subscription.id;
    }
    try {
      const { code, data } = await request[method](
        `${config.apiPrefix}subscriptions`,
        payload,
      );
      if (code === 200) {
        message.success(
          subscription ? intl.get('更新订阅成功') : intl.get('创建订阅成功'),
        );
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
      _alias = _url.match(_regx)![1].replaceAll('/', '_').replaceAll('.', '_');
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

    const numberChange = (value: number | null) => {
      setIntervalNumber(value || 1);
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
          addonBefore={intl.get('每')}
          precision={0}
          min={1}
          value={intervalNumber}
          style={{ width: 'calc(100% - 58px)' }}
          onChange={numberChange}
        />
        <Select value={intervalType} onChange={intervalTypeChange}>
          <Option value="days">{intl.get('天')}</Option>
          <Option value="hours">{intl.get('时')}</Option>
          <Option value="minutes">{intl.get('分')}</Option>
          <Option value="seconds">{intl.get('秒')}</Option>
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
        label={intl.get('私钥')}
        rules={[{ required: true }]}
      >
        <Input.TextArea
          rows={4}
          autoSize={{ minRows: 1, maxRows: 6 }}
          placeholder={intl.get('请输入私钥')}
        />
      </Form.Item>
    ) : (
      <>
        <Form.Item
          name={['pull_option', 'username']}
          label={intl.get('用户名')}
          rules={[{ required: true }]}
        >
          <Input placeholder={intl.get('请输入认证用户名')} />
        </Form.Item>
        <Form.Item
          name={['pull_option', 'password']}
          tooltip={intl.get('Github已不支持密码认证，请使用Token方式')}
          label={intl.get('密码/Token')}
          rules={[{ required: true }]}
        >
          <Input placeholder={intl.get('请输入密码或者Token')} />
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
        alias: formatAlias(url, branch, _type),
      });
      setType(_type);
    }
  }, []);

  const onNamePaste = useCallback((e) => {
    const text = e.clipboardData.getData('text') as string;
    if (text.includes('ql repo') || text.includes('ql raw')) {
      e.preventDefault();
    }
  }, []);

  const formatParams = (sub) => {
    return {
      ...sub,
      autoAddCron: isNil(sub?.autoAddCron) ? true : Boolean(sub?.autoAddCron),
      autoDelCron: isNil(sub?.autoDelCron) ? true : Boolean(sub?.autoDelCron),
    };
  };

  useEffect(() => {
    if (visible) {
      window.addEventListener('paste', onPaste);
    } else {
      window.removeEventListener('paste', onPaste);
    }
  }, [visible]);

  useEffect(() => {
    form.setFieldsValue(
      { ...subscription, ...formatParams(subscription) } || {},
    );
    setType((subscription && subscription.type) || 'public-repo');
    setScheduleType((subscription && subscription.schedule_type) || 'crontab');
    setPullType((subscription && subscription.pull_type) || 'ssh-key');
    if (!subscription) {
      form.resetFields();
    }
  }, [subscription, visible]);

  return (
    <Modal
      title={subscription ? intl.get('编辑订阅') : intl.get('创建订阅')}
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
        <Form.Item
          name="name"
          label={intl.get('名称')}
          rules={[{ required: true }]}
        >
          <Input
            placeholder={intl.get('支持拷贝 ql repo/raw 命令，粘贴导入')}
            onPaste={onNamePaste}
          />
        </Form.Item>
        <Form.Item
          name="type"
          label={intl.get('类型')}
          rules={[{ required: true }]}
          initialValue={'public-repo'}
        >
          <Radio.Group onChange={typeChange}>
            <Radio value="public-repo">{intl.get('公开仓库')}</Radio>
            <Radio value="private-repo">{intl.get('私有仓库')}</Radio>
            <Radio value="file">{intl.get('单文件')}</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item
          name="url"
          label={intl.get('链接')}
          rules={[
            { required: true },
            { pattern: type === 'file' ? fileUrlRegx : repoUrlRegx },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={intl.get('请输入订阅链接')}
            onPaste={onNamePaste}
            onChange={onUrlChange}
          />
        </Form.Item>
        {type !== 'file' && (
          <Form.Item name="branch" label={intl.get('分支')}>
            <Input
              placeholder={intl.get('请输入分支')}
              onPaste={onNamePaste}
              onChange={onBranchChange}
            />
          </Form.Item>
        )}
        <Form.Item
          name="alias"
          label={intl.get('唯一值')}
          rules={[{ required: true, message: '' }]}
          tooltip={intl.get('唯一值用于日志目录和私钥别名')}
        >
          <Input placeholder={intl.get('自动生成')} disabled />
        </Form.Item>
        {type === 'private-repo' && (
          <>
            <Form.Item
              name="pull_type"
              label={intl.get('拉取方式')}
              initialValue={'ssh-key'}
              rules={[{ required: true }]}
            >
              <Radio.Group onChange={pullTypeChange}>
                <Radio value="ssh-key">{intl.get('私钥')}</Radio>
                <Radio value="user-pwd">{intl.get('用户名密码/Token')}</Radio>
              </Radio.Group>
            </Form.Item>
            <PullOptions type={pullType} />
          </>
        )}
        <Form.Item
          name="schedule_type"
          label={intl.get('定时类型')}
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
          label={intl.get('定时规则')}
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
                  return Promise.reject(intl.get('Subscription表达式格式有误'));
                }
              },
            },
          ]}
        >
          {scheduleType === 'interval' ? (
            <IntervalSelect />
          ) : (
            <Input
              onPaste={onNamePaste}
              placeholder={intl.get('秒(可选) 分 时 天 月 周')}
            />
          )}
        </Form.Item>
        {type !== 'file' && (
          <>
            <Form.Item
              name="whitelist"
              label={intl.get('白名单')}
              tooltip={intl.get('多个关键词竖线分割，支持正则表达式')}
            >
              <Input.TextArea
                rows={4}
                autoSize={{ minRows: 1, maxRows: 5 }}
                placeholder={intl.get(
                  '请输入脚本筛选白名单关键词，多个关键词竖线分割',
                )}
                onPaste={onNamePaste}
              />
            </Form.Item>
            <Form.Item
              name="blacklist"
              label={intl.get('黑名单')}
              tooltip={intl.get('多个关键词竖线分割，支持正则表达式')}
            >
              <Input.TextArea
                rows={4}
                autoSize={{ minRows: 1, maxRows: 5 }}
                placeholder={intl.get(
                  '请输入脚本筛选黑名单关键词，多个关键词竖线分割',
                )}
                onPaste={onNamePaste}
              />
            </Form.Item>
            <Form.Item
              name="dependences"
              label={intl.get('依赖文件')}
              tooltip={intl.get('多个关键词竖线分割，支持正则表达式')}
            >
              <Input.TextArea
                rows={4}
                autoSize={{ minRows: 1, maxRows: 5 }}
                placeholder={intl.get(
                  '请输入脚本依赖文件关键词，多个关键词竖线分割',
                )}
                onPaste={onNamePaste}
              />
            </Form.Item>
            <Form.Item
              name="extensions"
              label={intl.get('文件后缀')}
              tooltip={intl.get(
                '仓库需要拉取的文件后缀，多个后缀空格分隔，默认使用配置文件中的RepoFileExtensions',
              )}
            >
              <Input
                onPaste={onNamePaste}
                placeholder={intl.get('请输入文件后缀')}
              />
            </Form.Item>
            <Form.Item
              name="sub_before"
              label={intl.get('执行前')}
              tooltip={intl.get(
                '运行订阅前执行的命令，比如 cp/mv/python3 xxx.py/node xxx.js',
              )}
            >
              <Input.TextArea
                onPaste={onNamePaste}
                rows={4}
                autoSize={{ minRows: 1, maxRows: 5 }}
                placeholder={intl.get('请输入运行订阅前要执行的命令')}
              />
            </Form.Item>
            <Form.Item
              name="sub_after"
              label={intl.get('执行后')}
              tooltip={intl.get(
                '运行订阅后执行的命令，比如 cp/mv/python3 xxx.py/node xxx.js',
              )}
            >
              <Input.TextArea
                onPaste={onNamePaste}
                rows={4}
                autoSize={{ minRows: 1, maxRows: 5 }}
                placeholder={intl.get('请输入运行订阅后要执行的命令')}
              />
            </Form.Item>
          </>
        )}
        <Form.Item
          name="proxy"
          label={intl.get('代理')}
          tooltip={intl.get(
            '公开仓库支持HTTP/SOCK5代理，私有仓库支持SOCK5代理',
          )}
        >
          <Input
            onPaste={onNamePaste}
            placeholder={
              type === 'private-repo'
                ? 'SOCK5代理，例如 IP:PORT'
                : 'HTTP/SOCK5代理，例如 http://127.0.0.1:1080'
            }
          />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }} className="inline-form-item">
          <Form.Item
            name="autoAddCron"
            label={intl.get('自动添加任务')}
            valuePropName="checked"
            initialValue={true}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="autoDelCron"
            label={intl.get('自动删除任务')}
            valuePropName="checked"
            initialValue={true}
          >
            <Switch />
          </Form.Item>
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SubscriptionModal;
