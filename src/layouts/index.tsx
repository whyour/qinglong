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
import { request } from '@/utils/http';
import './index.less';
import vhCheck from 'vh-check';
import { version, changeLog } from '../version';

export default function (props: any) {
  const logout = () => {
    request.post(`${config.apiPrefix}logout`).then(() => {
      localStorage.removeItem(config.authKey);
      history.push('/login');
    });
  };

  useEffect(() => {
    const isAuth = localStorage.getItem(config.authKey);
    if (!isAuth) {
      history.push('/login');
    }
    vhCheck();
  }, []);

  useEffect(() => {
    if (props.location.pathname === '/') {
      history.push('/crontab');
    }
  }, [props.location.pathname]);

  useEffect(() => {
    const theme = localStorage.getItem('qinglong_dark_theme') || 'auto';
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
  }, []);

  if (props.location.pathname === '/login') {
    return props.children;
  }

  const isFirefox = navigator.userAgent.includes('Firefox');
  const isSafari =
    navigator.userAgent.includes('Safari') &&
    !navigator.userAgent.includes('Chrome');
  return (
    <ProLayout
      selectedKeys={[props.location.pathname]}
      title={
        <>
          控制面板
          <a href={changeLog} target="_blank" rel="noopener noreferrer">
            <span
              style={{
                fontSize: isFirefox ? 9 : 12,
                color: '#666',
                marginLeft: 5,
                zoom: isSafari ? 0.66 : 0.8,
              }}
            >
              {version}
            </span>
          </a>
        </>
      }
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
            path: 'logout',
            onTitleClick: () => logout(),
          },
        ];
      }}
      pageTitleRender={() => '控制面板'}
      {...defaultProps}
    >
      {props.children}
    </ProLayout>
  );
}
