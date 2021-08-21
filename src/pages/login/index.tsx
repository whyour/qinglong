import React, { Fragment, useEffect } from 'react';
import { Button, Row, Input, Form, message, notification } from 'antd';
import config from '@/utils/config';
import { history, Link } from 'umi';
import styles from './index.less';
import { request } from '@/utils/http';

const FormItem = Form.Item;

const Login = () => {
  const handleOk = (values: any) => {
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
              <div>
                <div>
                  最后登录时间：{new Date(lastlogon).toLocaleString() || '-'}
                </div>
                <div>最后登录地点：{lastaddr || '-'}</div>
                <div>最后登录IP：{lastip || '-'}</div>
              </div>
            ),
            duration: 5,
          });
          history.push('/crontab');
        } else if (data.code === 100) {
          message.warn(data.message);
        } else {
          message.error(data.message);
        }
      })
      .catch(function (error) {
        console.log(error);
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
              <Button
                type="primary"
                htmlType="submit"
                style={{ width: '100%' }}
              >
                登录
              </Button>
            </Row>
          </Form>
        </div>
      </div>
    </div>
  );
};

export default Login;
