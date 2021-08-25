import React, { Fragment, useEffect, useState } from 'react';
import {
  Button,
  Row,
  Input,
  Form,
  message,
  notification,
  Statistic,
} from 'antd';
import config from '@/utils/config';
import { history, Link } from 'umi';
import styles from './index.less';
import { request } from '@/utils/http';
import { useTheme } from '@/utils/hooks';

const FormItem = Form.Item;
const { Countdown } = Statistic;

const Login = () => {
  const [loading, setLoading] = useState(false);
  const [waitTime, setWaitTime] = useState<any>();
  const { theme } = useTheme();

  const handleOk = (values: any) => {
    setLoading(true);
    setWaitTime(null);
    request
      .post(`${config.apiPrefix}login`, {
        data: {
          username: values.username,
          password: values.password,
        },
      })
      .then((data) => {
        if (data.code === 200) {
          const { token, lastip, lastaddr, lastlogon } = data.data;
          localStorage.setItem(config.authKey, token);
          notification.success({
            message: '登录成功！',
            description: (
              <>
                <div>
                  上次登录时间：
                  {lastlogon ? new Date(lastlogon).toLocaleString() : '-'}
                </div>
                <div>上次登录地点：{lastaddr || '-'}</div>
                <div>上次登录IP：{lastip || '-'}</div>
              </>
            ),
            duration: 5,
          });
          history.push('/crontab');
        } else if (data.code === 100) {
          message.warn(data.message);
        } else if (data.code === 410) {
          message.error(data.message);
          setWaitTime(data.data);
        } else {
          message.error(data.message);
        }
        setLoading(false);
      })
      .catch(function (error) {
        console.log(error);
        setLoading(false);
      });
  };

  useEffect(() => {
    const isAuth = localStorage.getItem(config.authKey);
    if (isAuth) {
      history.push('/crontab');
    }
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.top}>
          <div className={styles.header}>
            <img
              alt="logo"
              className={styles.logo}
              src="/images/qinglong.png"
            />
            <span className={styles.title}>{config.siteName}</span>
          </div>
        </div>
        <div className={styles.main}>
          <Form onFinish={handleOk}>
            <FormItem
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
              hasFeedback
            >
              <Input placeholder="用户名" autoFocus />
            </FormItem>
            <FormItem
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
              hasFeedback
            >
              <Input type="password" placeholder="密码" />
            </FormItem>
            <Row>
              {waitTime ? (
                <Button type="primary" style={{ width: '100%' }} disabled>
                  请
                  <Countdown
                    valueStyle={{
                      color:
                        theme === 'vs'
                          ? 'rgba(0,0,0,.25)'
                          : 'rgba(232, 230, 227, 0.25)',
                    }}
                    className="inline-countdown"
                    onFinish={() => setWaitTime(null)}
                    format="ss"
                    value={Date.now() + 1000 * waitTime}
                  />
                  秒后重试
                </Button>
              ) : (
                <Button
                  type="primary"
                  htmlType="submit"
                  style={{ width: '100%' }}
                  loading={loading}
                >
                  登录
                </Button>
              )}
            </Row>
          </Form>
        </div>
      </div>
    </div>
  );
};

export default Login;
