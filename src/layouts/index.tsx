import React, { useEffect, useState } from 'react';
import ProLayout from '@ant-design/pro-layout';
import {
  enable as enableDarkMode,
  disable as disableDarkMode,
  auto as followSystemColorScheme,
  setFetchMethod,
} from 'darkreader';
import defaultProps from './defaultProps';
import { Link, history } from 'umi';
import { LogoutOutlined } from '@ant-design/icons';
import config from '@/utils/config';
import 'codemirror/mode/shell/shell.js';
import './index.less';

export default function (props: any) {
  const logout = () => {
    localStorage.removeItem(config.authKey);
    history.push('/login');
  };

  useEffect(() => {
    const isAuth = localStorage.getItem(config.authKey);
    if (!isAuth) {
      history.push('/login');
    }
  }, []);

  useEffect(() => {
    if (props.location.pathname === '/') {
      history.push('/cookie');
    }
  }, [props.location.pathname]);

  useEffect(() => {
    const theme = localStorage.getItem('qinglong_dark_theme') || 'auto';
    setFetchMethod(window.fetch);
    if (theme === 'dark') {
      enableDarkMode({ darkSchemeTextColor: '#fff' });
    } else if (theme === 'light') {
      disableDarkMode();
    } else {
      followSystemColorScheme({ darkSchemeTextColor: '#fff' });
    }
  }, []);

  if (props.location.pathname === '/login') {
    return props.children;
  }
  return (
    <ProLayout
      selectedKeys={[props.location.pathname]}
      title="控制面板"
      menuItemRender={(menuItemProps: any, defaultDom: any) => {
        if (
          menuItemProps.isUrl ||
          !menuItemProps.path ||
          location.pathname === menuItemProps.path
        ) {
          return defaultDom;
        }
        return <Link to={menuItemProps.path}>{defaultDom}</Link>;
      }}
      postMenuData={(menuData) => {
        return [
          ...(menuData || []),
          {
            icon: <LogoutOutlined />,
            name: '退出登录',
            onTitleClick: () => logout(),
          },
        ];
      }}
      {...defaultProps}
    >
      {props.children}
    </ProLayout>
  );
}
