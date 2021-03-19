import React, { useState, useEffect } from 'react';
import { Button, notification, Input, Form, Radio, Tabs } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import {
  enable as enableDarkMode,
  disable as disableDarkMode,
  setFetchMethod,
} from 'darkreader';

const optionsWithDisabled = [
  { label: '亮色', value: 'light' },
  { label: '暗色', value: 'dark' },
  { label: '跟随系统', value: 'auto' },
];

const Password = () => {
  const [width, setWdith] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const colorScheme =
    window.matchMedia('(prefers-color-scheme: dark)').matches && 'dark';
  const defaultDarken =
    localStorage.getItem('qinglong_dark_theme') || colorScheme;
  const [theme, setTheme] = useState(defaultDarken);

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

  const themeChange = (e: any) => {
    setTheme(e.target.value);
    localStorage.setItem('qinglong_dark_theme', e.target.value);
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

  useEffect(() => {
    setFetchMethod(window.fetch);
    if (theme === 'dark') {
      enableDarkMode({ darkSchemeTextColor: '#fff' });
    } else if (theme === 'light') {
      disableDarkMode();
    } else {
      enableDarkMode({ darkSchemeTextColor: '#fff' });
    }
  }, [theme]);

  return (
    <PageContainer
      className="code-mirror-wrapper"
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
      style={{
        height: '100vh',
      }}
    >
      <Tabs
        defaultActiveKey="person"
        tabPosition="left"
        style={{ padding: '16px 0', height: 'calc(100vh - 96px)' }}
      >
        <Tabs.TabPane tab="个人设置" key="person">
          <Form onFinish={handleOk} layout="vertical">
            <Form.Item
              label="用户名"
              name="username"
              rules={[{ required: true }]}
              hasFeedback
              style={{ width: 300 }}
            >
              <Input placeholder="用户名" autoFocus />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true }]}
              hasFeedback
              style={{ width: 300 }}
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
