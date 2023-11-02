import intl from 'react-intl-universal';
import React, { Fragment, useEffect, useState } from 'react';
import {
  Button,
  Row,
  Input,
  Form,
  message,
  Typography,
  Steps,
  Select,
} from 'antd';
import config from '@/utils/config';
import { history } from '@umijs/max';
import styles from './index.less';
import { request } from '@/utils/http';

const FormItem = Form.Item;
const { Step } = Steps;
const { Option } = Select;
const { Link } = Typography;

const Initialization = () => {
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = React.useState(0);
  const [fields, setFields] = useState<any[]>([]);

  const next = () => {
    setCurrent(current + 1);
  };

  const prev = () => {
    setCurrent(current - 1);
  };

  const submitAccountSetting = (values: any) => {
    setLoading(true);
    request
      .put(`${config.apiPrefix}user/init`, {
        username: values.username,
        password: values.password,
      })
      .then(({ code, data }) => {
        if (code === 200) {
          next();
        }
      })
      .finally(() => setLoading(false));
  };

  const submitNotification = (values: any) => {
    setLoading(true);
    request
      .put(`${config.apiPrefix}user/notification/init`, values)
      .then(({ code, data }) => {
        if (code === 200) {
          next();
        }
      })
      .finally(() => setLoading(false));
  };

  const notificationModeChange = (value: string) => {
    const _fields = (config.notificationModeMap as any)[value];
    setFields(_fields || []);
  };

  useEffect(() => {
    localStorage.removeItem(config.authKey);
  }, []);

  const steps = [
    {
      title: intl.get('欢迎使用'),
      content: (
        <div className={styles.top} style={{ marginTop: 30 }}>
          <div className={styles.header}>
            <span className={styles.title}>{intl.get('欢迎使用青龙')}</span>
            <span className={styles.desc}>
              {intl.get(
                '支持python3、javascript、shell、typescript 的定时任务管理面板',
              )}
            </span>
          </div>
          <div className={styles.action}>
            <Button
              type="primary"
              onClick={() => {
                next();
              }}
            >
              {intl.get('开始安装')}
            </Button>
          </div>
        </div>
      ),
    },
    {
      title: intl.get('通知设置'),
      content: (
        <Form onFinish={submitNotification} layout="vertical">
          <Form.Item
            label={intl.get('通知方式')}
            name="type"
            rules={[{ required: true, message: intl.get('请选择通知方式') }]}
            style={{ maxWidth: 350 }}
          >
            <Select
              onChange={notificationModeChange}
              placeholder={intl.get('请选择通知方式')}
            >
              {config.notificationModes
                .filter((x) => x.value !== 'closed')
                .map((x) => (
                  <Option key={x.value} value={x.value}>
                    {x.label}
                  </Option>
                ))}
            </Select>
          </Form.Item>
          {fields.map((x) => (
            <Form.Item
              key={x.label}
              label={x.label}
              name={x.label}
              extra={x.tip}
              rules={[{ required: x.required }]}
              style={{ maxWidth: 400 }}
            >
              <Input.TextArea
                autoSize={{ minRows: 1, maxRows: 5 }}
                placeholder={`请输入${x.label}`}
              />
            </Form.Item>
          ))}
          <Button type="primary" htmlType="submit" loading={loading}>
            {intl.get('保存')}
          </Button>
          <Button type="link" htmlType="button" onClick={() => next()}>
            {intl.get('跳过')}
          </Button>
        </Form>
      ),
    },
    {
      title: intl.get('账户设置'),
      content: (
        <Form onFinish={submitAccountSetting} layout="vertical">
          <Form.Item
            label={intl.get('用户名')}
            name="username"
            rules={[{ required: true }]}
            style={{ maxWidth: 350 }}
          >
            <Input placeholder={intl.get('用户名')} />
          </Form.Item>
          <Form.Item
            label={intl.get('密码')}
            name="password"
            rules={[
              { required: true },
              {
                pattern: /^(?!admin$).*$/,
                message: intl.get('密码不能为admin'),
              },
            ]}
            hasFeedback
            style={{ maxWidth: 350 }}
          >
            <Input type="password" placeholder={intl.get('密码')} />
          </Form.Item>
          <Form.Item
            name="confirm"
            label={intl.get('确认密码')}
            dependencies={['password']}
            hasFeedback
            style={{ maxWidth: 350 }}
            rules={[
              {
                required: true,
              },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(
                    new Error(intl.get('您输入的两个密码不匹配！')),
                  );
                },
              }),
            ]}
          >
            <Input.Password placeholder={intl.get('确认密码')} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            {intl.get('提交')}
          </Button>
        </Form>
      ),
    },
    {
      title: intl.get('完成安装'),
      content: (
        <div className={styles.top} style={{ marginTop: 80 }}>
          <div className={styles.header}>
            <span className={styles.title}>{intl.get('恭喜安装完成！')}</span>
            <Link href="https://github.com/whyour/qinglong" target="_blank">
              Github
            </Link>
            <Link href="https://t.me/jiao_long" target="_blank">
              {intl.get('Telegram频道')}
            </Link>
          </div>
          <div style={{ marginTop: 16 }}>
            <Button
              type="primary"
              onClick={() => {
                window.location.reload();
              }}
            >
              {intl.get('去登录')}
            </Button>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className={styles.container}>
      <div className={styles.top}>
        <div className={styles.header}>
          <img
            alt="logo"
            className={styles.logo}
            src="https://qn.whyour.cn/logo.png"
          />
          <span className={styles.title}>{intl.get('初始化配置')}</span>
        </div>
      </div>
      <div className={styles.main}>
        <Steps
          current={current}
          direction="vertical"
          size="small"
          className={styles['ant-steps']}
        >
          {steps.map((item) => (
            <Step key={item.title} title={item.title} />
          ))}
        </Steps>
        <div className={styles['steps-container']}>
          {steps[current].content}
        </div>
      </div>
    </div>
  );
};

export default Initialization;
