import React, { useEffect, useState } from 'react';
import ProLayout from '@ant-design/pro-layout';
import {
  enable as enableDarkMode,
  disable as disableDarkMode,
  setFetchMethod,
} from 'darkreader';
import defaultProps from './defaultProps';
import { Link, history } from 'umi';
import config from '@/utils/config';
import 'codemirror/mode/shell/shell.js';
import './index.less';

export default function (props: any) {
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
    const colorScheme =
      window.matchMedia('(prefers-color-scheme: dark)').matches && 'dark';
    console.log(colorScheme);
    let localTheme = localStorage.getItem('qinglong_dark_theme');
    if (localTheme === 'auto') {
      localTheme = null;
    }
    const theme = localTheme || colorScheme || 'light';
    setFetchMethod(window.fetch);
    if (theme === 'dark') {
      enableDarkMode({ darkSchemeTextColor: '#fff' });
    } else if (theme === 'light') {
      disableDarkMode();
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
      {...defaultProps}
    >
      {props.children}
    </ProLayout>
  );
}
