import React, { PureComponent, Fragment, useState, useEffect } from 'react';
import { Button, notification, Input, Form } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { Controlled as CodeMirror } from 'react-codemirror2';
import { request } from '@/utils/http';

const Password = () => {
  const [width, setWdith] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);

  const handleOk = (values: any) => {
    request
      .post(`${config.apiPrefix}auth?t=${Date.now()}`, {
        data: {
          username: values.username,
          password: values.password,
        },
      })
      .then((data) => {
        if (data.err == 0) {
          localStorage.setItem(config.authKey, 'true');
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
    if (document.body.clientWidth < 768) {
      setWdith('auto');
      setMarginLeft(0);
      setMarginTop(0);
    } else {
      setWdith('100%');
      setMarginLeft(0);
      setMarginTop(-72);
    }
  }, []);

  return (
    <PageContainer
      className="code-mirror-wrapper"
      title="修改密码"
      header={{
        style: {
          padding: '4px 16px 4px 15px',
          position: 'sticky',
          top: 0,
          left: 0,
          zIndex: 20,
          marginTop,
          width,
          marginLeft,
        },
      }}
      style={{
        height: '100vh',
      }}
    >
      <Form
        onFinish={handleOk}
        style={{ padding: 20, height: 'calc(100vh - 96px)' }}
      >
        <Form.Item
          name="username"
          rules={[{ required: true, message: '请输入用户名' }]}
          hasFeedback
          style={{ width: 300 }}
        >
          <Input placeholder="用户名" autoFocus />
        </Form.Item>
        <Form.Item
          name="password"
          rules={[{ required: true, message: '请输入密码' }]}
          hasFeedback
          style={{ width: 300 }}
        >
          <Input type="password" placeholder="密码" />
        </Form.Item>
        <Button type="primary" htmlType="submit">
          保存
        </Button>
      </Form>
    </PageContainer>
  );
};

export default Password;
