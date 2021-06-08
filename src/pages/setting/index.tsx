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

const optionsWithDisabled = [
  { label: '亮色', value: 'light' },
  { label: '暗色', value: 'dark' },
  { label: '跟随系统', value: 'auto' },
];

const Password = () => {
  const [width, setWidth] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const defaultDarken = localStorage.getItem('qinglong_dark_theme') || 'auto';
  const [theme, setTheme] = useState(defaultDarken);

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
    if (document.body.clientWidth < 768) {
      setWidth('auto');
      setMarginLeft(0);
      setMarginTop(0);
    } else {
      setWidth('100%');
      setMarginLeft(0);
      setMarginTop(-72);
    }
  }, []);

  useEffect(() => {
    setFetchMethod(window.fetch);
    if (theme === 'dark') {
      enableDarkMode({
        brightness: 100,
        contrast: 90,
        sepia: 10,
      });
    } else if (theme === 'light') {
      disableDarkMode();
    } else {
      followSystemColorScheme({
        brightness: 100,
        contrast: 90,
        sepia: 10,
      });
    }
  }, [theme]);

  return (
    <PageContainer
      className="ql-container-wrapper"
      title="系统设置"
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
    >
      <Tabs
        defaultActiveKey="person"
        size="small"
        tabPosition="top"
        style={{ height: 'calc(100vh - var(--vh-offset, 0px) - 128px)' }}
      >
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
