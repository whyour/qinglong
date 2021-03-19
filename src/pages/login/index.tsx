import React, { Fragment, useEffect } from 'react';
import { Button, Row, Input, Form, notification } from 'antd';
import config from '@/utils/config';
import { history, Link } from 'umi';
import styles from './index.less';
import { request } from '@/utils/http';
import logo from '@/assets/logo.png';

const FormItem = Form.Item;

const Login = () => {
  const handleOk = (values: any) => {
    request
      .post(`${config.apiPrefix}auth`, {
        data: {
          username: values.username,
          password: values.password,
        },
      })
      .then((data) => {
        if (data.err == 0) {
          localStorage.setItem(config.authKey, data.token);
          history.push('/cookie');
        } else {
          notification.open({
            message: data.msg,
          });
        }
      })
      .catch(function (error) {
        console.log(error);
      });
  };

  useEffect(() => {
    const isAuth = localStorage.getItem(config.authKey);
    if (isAuth) {
      history.push('/cookie');
    }
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.top}>
          <div className={styles.header}>
            <img alt="logo" className={styles.logo} src={logo} />
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
