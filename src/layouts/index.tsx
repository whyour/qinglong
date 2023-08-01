import intl from 'react-intl-universal';
import React, { useEffect, useState, useRef } from 'react';
import ProLayout, { PageLoading } from '@ant-design/pro-layout';
import * as DarkReader from '@umijs/ssr-darkreader';
import defaultProps from './defaultProps';
import { Link, history, Outlet, useLocation } from '@umijs/max';
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
import { useCtx, useTheme } from '@/utils/hooks';
import {
  message,
  Badge,
  Modal,
  Avatar,
  Dropdown,
  Menu,
  Image,
  Popover,
  Descriptions,
  Tooltip,
  MenuProps,
} from 'antd';
// @ts-ignore
import SockJS from 'sockjs-client';
import * as Sentry from '@sentry/react';
import { init } from '../utils/init';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/mode/python/python';
import 'codemirror/mode/shell/shell';

export interface SharedContext {
  headerStyle: React.CSSProperties;
  isPhone: boolean;
  theme: 'vs' | 'vs-dark';
  user: any;
  reloadUser: (needLoading?: boolean) => void;
  reloadTheme: () => void;
  socketMessage: any;
  systemInfo: TSystemInfo;
}

interface TSystemInfo {
  branch: 'develop' | 'master';
  isInitialized: boolean;
  publishTime: number;
  version: string;
  changeLog: string;
  changeLogLink: string;
}

export default function () {
  const location = useLocation();
  const ctx = useCtx();
  const { theme, reloadTheme } = useTheme();
  const [user, setUser] = useState<any>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [systemInfo, setSystemInfo] = useState<TSystemInfo>();
  const ws = useRef<any>(null);
  const [socketMessage, setSocketMessage] = useState<any>();
  const [collapsed, setCollapsed] = useState(false);
  const [initLoading, setInitLoading] = useState<boolean>(true);
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
          } else {
            init(data.version);
            getUser();
          }
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
          if (location.pathname === '/') {
            history.push('/crontab');
          }
        }
        needLoading && setLoading(false);
      })
      .catch((error) => {
        console.log(error);
      });
  };

  const getHealthStatus = () => {
    request
      .get(`${config.apiPrefix}public/health`)
      .then((res) => {
        if (res?.data?.status === 1) {
          getSystemInfo();
        } else {
          history.push('/error');
        }
      })
      .catch((error) => {
        history.push('/error');
      })
      .finally(() => setInitLoading(false));
  };

  const reloadUser = (needLoading = false) => {
    getUser(needLoading);
  };

  useEffect(() => {
    if (systemInfo && systemInfo.isInitialized && !user) {
      getUser();
    }
  }, [location.pathname]);

  useEffect(() => {
    getHealthStatus();
  }, []);

  useEffect(() => {
    if (theme === 'vs-dark') {
      document.body.setAttribute('data-dark', 'true');
    } else {
      document.body.setAttribute('data-dark', 'false');
    }
  }, [theme]);

  useEffect(() => {
    vhCheck();

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
    if (!user || !user.username) return;
    ws.current = new SockJS(
      `${window.location.origin}/api/ws?token=${localStorage.getItem(
        config.authKey,
      )}`,
    );

    ws.current.onmessage = (e: any) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'ping') {
          if (data && data.message === 'hanhh') {
            console.log('WS connection succeeded !!!');
          } else {
            console.log('WS connection Failed !!!', e);
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

  if (initLoading) {
    return <PageLoading />;
  }

  if (['/login', '/initialization', '/error'].includes(location.pathname)) {
    if (systemInfo?.isInitialized && location.pathname === '/initialization') {
      history.push('/crontab');
    }

    if (systemInfo || location.pathname === '/error') {
      return (
        <Outlet
          context={{
            ...ctx,
            theme,
            user,
            reloadUser,
            reloadTheme,
            ws: ws.current,
          }}
        />
      );
    }
  }

  const isFirefox = navigator.userAgent.includes('Firefox');
  const isSafari =
    navigator.userAgent.includes('Safari') &&
    !navigator.userAgent.includes('Chrome');
  const isQQBrowser = navigator.userAgent.includes('QQBrowser');

  const menu: MenuProps = {
    items: [
      {
        label: intl.get('退出登录'),
        className: 'side-menu-user-drop-menu',
        onClick: logout,
        key: 'logout',
        icon: <LogoutOutlined />,
      },
    ],
  };
  return loading ? (
    <PageLoading />
  ) : (
    <ProLayout
      selectedKeys={[location.pathname]}
      loading={loading}
      ErrorBoundary={Sentry.ErrorBoundary}
      logo={
        <>
          <Image preview={false} src="https://qn.whyour.cn/logo.png" />
          <div className="title">
            <span className="title">{intl.get('青龙')}</span>
            <a
              href={systemInfo?.changeLogLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <Tooltip
                title={
                  systemInfo?.branch === 'develop'
                    ? intl.get('开发版')
                    : intl.get('正式版')
                }
              >
                <Badge size="small" dot={systemInfo?.branch === 'develop'}>
                  <span
                    style={{
                      fontSize: isFirefox ? 9 : 12,
                      color: '#666',
                      marginLeft: 2,
                      zoom: isSafari ? 0.66 : 0.8,
                      letterSpacing: isQQBrowser ? -2 : 0,
                    }}
                  >
                    v{systemInfo?.version}
                  </span>
                </Badge>
              </Tooltip>
            </a>
          </div>
        </>
      }
      title={false}
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
        const title =
          (config.documentTitleMap as any)[location.pathname] ||
          intl.get('未找到');
        return `${title} - ${intl.get('青龙')}`;
      }}
      onCollapse={setCollapsed}
      collapsed={collapsed}
      rightContentRender={() =>
        ctx.isPhone && (
          <Dropdown menu={menu} placement="bottomRight" trigger={['click']}>
            <span className="side-menu-user-wrapper">
              <Avatar
                shape="square"
                size="small"
                icon={<UserOutlined />}
                src={user.avatar ? `/api/static/${user.avatar}` : ''}
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
            <Dropdown menu={menu} placement="topLeft" trigger={['hover']}>
              <span className="side-menu-user-wrapper">
                <Avatar
                  shape="square"
                  size="small"
                  icon={<UserOutlined />}
                  src={user.avatar ? `/api/static/${user.avatar}` : ''}
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
      <Outlet
        context={{
          ...ctx,
          theme,
          user,
          reloadUser,
          reloadTheme,
          socketMessage,
          systemInfo,
        }}
      />
    </ProLayout>
  );
}
