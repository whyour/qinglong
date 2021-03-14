import React, { Fragment, useEffect } from 'react';
import { Button, Row, Input, Form, notification } from 'antd';
import config from '@/utils/config';
import { history } from 'umi';
import styles from './index.less';
import { request } from '@/utils/http';

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
          localStorage.setItem(config.authKey, 'true');
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
  }, [])

  return (
    <Fragment>
      <div className={styles.form}>
        <div className={styles.logo}>
          <span>{config.siteName}</span>
        </div>
        <Form onFinish={handleOk}>
          <FormItem
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
            hasFeedback
          >
            <Input placeholder="用户名" autoFocus/>
          </FormItem>
          <FormItem
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
            hasFeedback
          >
            <Input type="password" placeholder="密码" />
          </FormItem>
          <Row>
            <Button type="primary" htmlType="submit">
              Sign in
            </Button>
          </Row>
        </Form>
      </div>
    </Fragment>
  );
};

export default Login;
