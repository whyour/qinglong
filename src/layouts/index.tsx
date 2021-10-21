import React, { useEffect, useState, useRef } from 'react';
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
// @ts-ignore
import SockJS from 'sockjs-client';

export default function (props: any) {
  const ctx = useCtx();
  const theme = useTheme();
  const [user, setUser] = useState<any>();
  const [loading, setLoading] = useState<boolean>(true);
  const [systemInfo, setSystemInfo] = useState<{ isInitialized: boolean }>();
  const ws = useRef<any>(null);

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

  useEffect(() => {
    ws.current = new SockJS(
      `${location.origin}/api/ws?token=${localStorage.getItem(config.authKey)}`,
    );

    ws.current.onmessage = (e: any) => {
      if (e.data === 'hanhh') {
        console.log('websocket连接成功', e);
      } else {
        console.log('websocket连接失败', e);
      }
    };

    const wsCurrent = ws.current;

    return () => {
      wsCurrent.close();
    };
  }, []);

  if (['/login', '/initialization'].includes(props.location.pathname)) {
    document.title = `${
      (config.documentTitleMap as any)[props.location.pathname]
    } - 控制面板`;
    if (
      systemInfo?.isInitialized &&
      props.location.pathname === '/initialization'
    ) {
      history.push('/crontab');
    }

    if (systemInfo) {
      return React.Children.map(props.children, (child) => {
        return React.cloneElement(child, {
          ...ctx,
          ...theme,
          user,
          reloadUser,
          reloadTheme: setTheme,
          ws: ws.current,
        });
      });
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
          ws: ws.current,
        });
      })}
    </ProLayout>
  );
}
