import React, { useState, useEffect } from 'react';
import { Button, Input, Form, Radio, Tabs } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import {
  enable as enableDarkMode,
  disable as disableDarkMode,
  auto as followSystemColorScheme,
  setFetchMethod,
} from 'darkreader';
import { history } from 'umi';
import { useCtx } from '@/utils/hooks';

const optionsWithDisabled = [
  { label: '亮色', value: 'light' },
  { label: '暗色', value: 'dark' },
  { label: '跟随系统', value: 'auto' },
];

const Password = () => {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const defaultDarken = localStorage.getItem('qinglong_dark_theme') || 'auto';
  const [theme, setTheme] = useState(defaultDarken);
  const { headerStyle, isPhone } = useCtx();

  const handleOk = (values: any) => {
    request
      .post(`${config.apiPrefix}user`, {
        data: {
          username: values.username,
          password: values.password,
        },
      })
      .then((data: any) => {
        localStorage.removeItem(config.authKey);
        history.push('/login');
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const themeChange = (e: any) => {
    setTheme(e.target.value);
    localStorage.setItem('qinglong_dark_theme', e.target.value);
  };

  const importJob = () => {
    request.get(`${config.apiPrefix}crons/import`).then((data: any) => {
      console.log(data);
    });
  };

  useEffect(() => {
    setFetchMethod(window.fetch);
    if (theme === 'dark') {
      enableDarkMode({});
    } else if (theme === 'light') {
      disableDarkMode();
    } else {
      followSystemColorScheme({});
    }
  }, [theme]);

  return (
    <PageContainer
      className="ql-container-wrapper"
      title="系统设置"
      header={{
        style: headerStyle,
      }}
    >
      <Tabs defaultActiveKey="person" size="small" tabPosition="top">
        <Tabs.TabPane tab="个人设置" key="person">
          <Form onFinish={handleOk} layout="vertical">
            <Form.Item
              label="用户名"
              name="username"
              rules={[{ required: true }]}
              hasFeedback
              style={{ maxWidth: 300 }}
            >
              <Input placeholder="用户名" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true }]}
              hasFeedback
              style={{ maxWidth: 300 }}
            >
              <Input type="password" placeholder="密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit">
              保存
            </Button>
          </Form>
        </Tabs.TabPane>
        <Tabs.TabPane tab="其他设置" key="theme">
          <Form layout="vertical">
            <Form.Item label="主题设置" name="theme" initialValue={theme}>
              <Radio.Group
                options={optionsWithDisabled}
                onChange={themeChange}
                value={theme}
                optionType="button"
                buttonStyle="solid"
              />
            </Form.Item>
          </Form>
        </Tabs.TabPane>
      </Tabs>
    </PageContainer>
  );
};

export default Password;
