import React, { useEffect, useState } from 'react';
import { Button, Descriptions, Result, Avatar, Space, Statistic } from 'antd';
import { LikeOutlined, UserOutlined } from '@ant-design/icons';
import ProLayout, {
  PageContainer,
  PageLoading,
  SettingDrawer,
} from '@ant-design/pro-layout';
import defaultProps from './defaultProps';
import { Link, history } from 'umi';
import config from '@/utils/config';
import 'codemirror/mode/shell/shell.js'
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
      history.push('/config');
    }
  }, [props.location.pathname]);
  if (props.location.pathname === '/login') {
    return props.children;
  }
  return (
    <ProLayout
      selectedKeys={[props.location.pathname]}
      title="控制面板"
      menuItemRender={(menuItemProps: any, defaultDom) => {
        if (
          menuItemProps.isUrl ||
          !menuItemProps.path ||
          location.pathname === menuItemProps.path
        ) {
          return defaultDom;
        }
        return <Link to={menuItemProps.path}>{defaultDom}</Link>;
      }}
    //   rightContentRender={() => (
    //       <div>
    //           <Avatar shape="square" size="small" icon={<UserOutlined />} />
    //       </div>
    //   )}
      {...defaultProps}
    >
      {props.children}
    </ProLayout>
  );
}
