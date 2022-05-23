import React, { useEffect, useState, useRef } from 'react';
import ProLayout, { PageLoading } from '@ant-design/pro-layout';
import * as DarkReader from '@umijs/ssr-darkreader';
import defaultProps from './defaultProps';
import { Link, history } from 'umi';
import {
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons';
import config from '@/utils/config';
import { request } from '@/utils/http';
import './index.less';
import vhCheck from 'vh-check';
import { version, changeLogLink, changeLog } from '../version';
import { useCtx, useTheme } from '@/utils/hooks';
import { message, Badge, Modal, Avatar, Dropdown, Menu, Image } from 'antd';
// @ts-ignore
import SockJS from 'sockjs-client';
import * as Sentry from '@sentry/react';
import { init } from '../utils/init';

export default function (props: any) {
  const ctx = useCtx();
  const { theme, reloadTheme } = useTheme();
  const [user, setUser] = useState<any>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [systemInfo, setSystemInfo] = useState<{ isInitialized: boolean }>();
  const ws = useRef<any>(null);
  const [socketMessage, setSocketMessage] = useState<any>();
  const [collapsed, setCollapsed] = useState(false);
  const {
    enable: enableDarkMode,
    disable: disableDarkMode,
    exportGeneratedCSS: collectCSS,
    setFetchMethod,
    auto: followSystemColorScheme,
  } = DarkReader || {};

  const logout = () => {
    request.post(`${config.apiPrefix}user/logout`).then(() => {
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

  const reloadUser = (needLoading = false) => {
    getUser(needLoading);
  };

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
    if (theme === 'vs-dark') {
      document.body.setAttribute('data-dark', 'true');
    } else {
      document.body.setAttribute('data-dark', 'false');
    }
  }, [theme]);

  useEffect(() => {
    vhCheck();
    init();

    const _theme = localStorage.getItem('qinglong_dark_theme') || 'auto';
    if (typeof window === 'undefined') return;
    if (typeof window.matchMedia === 'undefined') return;
    if (!DarkReader) {
      return () => null;
    }
    setFetchMethod(fetch);

    if (_theme === 'dark') {
      enableDarkMode({});
    } else if (_theme === 'light') {
      disableDarkMode();
    } else {
      followSystemColorScheme({});
    }

    return () => {
      disableDarkMode();
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    ws.current = new SockJS(
      `${location.origin}/api/ws?token=${localStorage.getItem(config.authKey)}`,
    );

    ws.current.onmessage = (e: any) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'ping') {
          if (data && data.message === 'hanhh') {
            console.log('websocket连接成功', e);
          } else {
            console.log('websocket连接失败', e);
          }
        }
        setSocketMessage(data);
      } catch (error) {
        console.log('websocket连接失败', e);
      }
    };

    const wsCurrent = ws.current;

    return () => {
      wsCurrent.close();
    };
  }, [user]);

  useEffect(() => {
    window.onload = () => {
      const timing = performance.timing;
      console.log(`白屏时间: ${timing.responseStart - timing.navigationStart}`);
      console.log(
        `请求完毕至DOM加载: ${timing.domInteractive - timing.responseEnd}`,
      );
      console.log(
        `解释dom树耗时: ${timing.domComplete - timing.domInteractive}`,
      );
      console.log(
        `从开始至load总耗时: ${timing.loadEventEnd - timing.navigationStart}`,
      );
      Sentry.captureMessage(
        `白屏时间 ${timing.responseStart - timing.navigationStart}`,
      );
    };
  }, []);

  if (
    ['/login', '/initialization', '/error'].includes(props.location.pathname)
  ) {
    document.title = `${
      (config.documentTitleMap as any)[props.location.pathname]
    } - 控制面板`;
    if (
      systemInfo?.isInitialized &&
      props.location.pathname === '/initialization'
    ) {
      history.push('/crontab');
    }

    if (systemInfo || props.location.pathname === '/error') {
      return React.Children.map(props.children, (child) => {
        return React.cloneElement(child, {
          ...ctx,
          theme,
          user,
          reloadUser,
          reloadTheme,
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

  const menu = (
    <Menu
      className="side-menu-user-drop-menu"
      items={[{ label: '退出登录', key: 'logout', icon: <LogoutOutlined /> }]}
      onClick={logout}
    />
  );
  return loading ? (
    <PageLoading />
  ) : (
    <ProLayout
      selectedKeys={[props.location.pathname]}
      loading={loading}
      ErrorBoundary={Sentry.ErrorBoundary}
      logo={<Image preview={false} src="http://qn.whyour.cn/logo.png" />}
      title={
        <>
          <span style={{ fontSize: 16 }}>控制面板</span>
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
      pageTitleRender={(props, pageName, info) => {
        if (info && typeof info.pageName === 'string') {
          return `${info.pageName} - 控制面板`;
        }
        return '控制面板';
      }}
      onCollapse={setCollapsed}
      collapsed={collapsed}
      rightContentRender={() =>
        ctx.isPhone && (
          <Dropdown overlay={menu} placement="bottomRight" trigger={['click']}>
            <span className="side-menu-user-wrapper">
              <Avatar
                shape="square"
                size="small"
                icon={<UserOutlined />}
                src={`/api/static/${user.avatar}`}
              />
              <span style={{ marginLeft: 5 }}>{user.username}</span>
            </span>
          </Dropdown>
        )
      }
      collapsedButtonRender={(collapsed) => (
        <span
          className="side-menu-container"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {!collapsed && !ctx.isPhone && (
            <Dropdown overlay={menu} placement="topLeft" trigger={['hover']}>
              <span className="side-menu-user-wrapper">
                <Avatar
                  shape="square"
                  size="small"
                  icon={<UserOutlined />}
                  src={`/api/static/${user.avatar}`}
                />
                <span style={{ marginLeft: 5 }}>{user.username}</span>
              </span>
            </Dropdown>
          )}
          <span
            className="side-menu-collapse-button"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </span>
        </span>
      )}
      {...defaultProps}
    >
      {React.Children.map(props.children, (child) => {
        return React.cloneElement(child, {
          ...ctx,
          theme,
          user,
          reloadUser,
          reloadTheme,
          socketMessage,
        });
      })}
    </ProLayout>
  );
}
