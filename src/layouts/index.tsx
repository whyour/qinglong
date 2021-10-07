import React, { useEffect, useState } from 'react';
import ProLayout, { PageLoading } from '@ant-design/pro-layout';
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
import { request } from '@/utils/http';
import './index.less';
import vhCheck from 'vh-check';
import { version, changeLogLink, changeLog } from '../version';
import { useCtx, useTheme } from '@/utils/hooks';
import { message, Badge, Modal } from 'antd';

export default function (props: any) {
  const ctx = useCtx();
  const theme = useTheme();
  const [user, setUser] = useState<any>();
  const [loading, setLoading] = useState<boolean>(true);
  const [systemInfo, setSystemInfo] = useState<{ isInitialized: boolean }>();

  const logout = () => {
    request.post(`${config.apiPrefix}logout`).then(() => {
      localStorage.removeItem(config.authKey);
      history.push('/login');
    });
  };

  const getSystemInfo = () => {
    request
      .get(`${config.apiPrefix}system`)
      .then(({ code, data }) => {
        if (code === 200) {
          setSystemInfo(data);
          if (!data.isInitialized) {
            history.push('/initialization');
            setLoading(false);
          } else {
            getUser();
          }
        } else {
          message.error(data);
        }
      })
      .catch((error) => {
        console.log(error);
      });
  };

  const getUser = (needLoading = true) => {
    needLoading && setLoading(true);
    request
      .get(`${config.apiPrefix}user`)
      .then(({ code, data }) => {
        if (code === 200 && data.username) {
          setUser(data);
          if (props.location.pathname === '/') {
            history.push('/crontab');
          }
        } else {
          message.error(data);
        }
        needLoading && setLoading(false);
      })
      .catch((error) => {
        console.log(error);
      });
  };

  const reloadUser = () => {
    getUser(false);
  };

  const setTheme = () => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const storageTheme = localStorage.getItem('qinglong_dark_theme');
    const isDark =
      (media.matches && storageTheme !== 'light') || storageTheme === 'dark';
    if (isDark) {
      document.body.setAttribute('data-dark', 'true');
    } else {
      document.body.setAttribute('data-dark', 'false');
    }
  };

  const showNewVersionModal = () => {
    Modal.confirm({
      width: 500,
      title: (
        <>
          <div>更新可用</div>
          <div style={{ fontSize: 12, fontWeight: 400, marginTop: 5 }}>
            新版本5.8.0 (1780)可用。你使用的版本为{version}。
          </div>
        </>
      ),
      content: (
        <pre
          style={{
            wordBreak: 'break-all',
            whiteSpace: 'pre-wrap',
            paddingTop: 15,
            fontSize: 12,
            fontWeight: 400,
          }}
        >
          {changeLog}
        </pre>
      ),
      okText: '更新',
      cancelText: '以后再说',
      onOk() {
        console.log('ok');
      },
    });
  };

  useEffect(() => {
    vhCheck();
  }, []);

  useEffect(() => {
    if (systemInfo && systemInfo.isInitialized && !user) {
      getUser();
    }
  }, [props.location.pathname]);

  useEffect(() => {
    if (!systemInfo) {
      getSystemInfo();
    }
  }, [systemInfo]);

  useEffect(() => {
    setTheme();
  }, [theme.theme]);

  useEffect(() => {
    const _theme = localStorage.getItem('qinglong_dark_theme') || 'auto';
    setFetchMethod(window.fetch);
    if (_theme === 'dark') {
      enableDarkMode({});
    } else if (_theme === 'light') {
      disableDarkMode();
    } else {
      followSystemColorScheme({});
    }
  }, []);

  if (['/login', '/initialization'].includes(props.location.pathname)) {
    document.title = `${
      (config.documentTitleMap as any)[props.location.pathname]
    } - 控制面板`;
    if (systemInfo) {
      return props.children;
    }
  }

  const isFirefox = navigator.userAgent.includes('Firefox');
  const isSafari =
    navigator.userAgent.includes('Safari') &&
    !navigator.userAgent.includes('Chrome');
  const isQQBrowser = navigator.userAgent.includes('QQBrowser');

  return loading ? (
    <PageLoading />
  ) : (
    <ProLayout
      selectedKeys={[props.location.pathname]}
      loading={loading}
      title={
        <>
          控制面板
          <span onClick={showNewVersionModal}>
            <Badge
              count={'New'}
              size="small"
              offset={[15, 0]}
              style={{
                fontSize: isFirefox ? 9 : 12,
                zoom: isSafari ? 0.66 : 0.8,
                padding: '0 5px',
              }}
            >
              <a
                href={changeLogLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                <span
                  style={{
                    fontSize: isFirefox ? 9 : 12,
                    color: '#666',
                    marginLeft: 2,
                    zoom: isSafari ? 0.66 : 0.8,
                    letterSpacing: isQQBrowser ? -2 : 0,
                  }}
                >
                  v{version}
                </span>
              </a>
            </Badge>
          </span>
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
      pageTitleRender={(props, pageName, info) => {
        if (info && typeof info.pageName === 'string') {
          return `${info.pageName} - 控制面板`;
        }
        return '控制面板';
      }}
      {...defaultProps}
    >
      {React.Children.map(props.children, (child) => {
        return React.cloneElement(child, {
          ...ctx,
          ...theme,
          user,
          reloadUser,
          reloadTheme: setTheme,
        });
      })}
    </ProLayout>
  );
}
