import intl from 'react-intl-universal';
import React, { useState, useEffect, useRef } from 'react';
import {
  Button,
  InputNumber,
  Form,
  Radio,
  Tabs,
  Table,
  Tooltip,
  Space,
  Tag,
  Modal,
  message,
  Typography,
  Input,
} from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import AppModal from './appModal';
import {
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import SecuritySettings from './security';
import LoginLog from './loginLog';
import NotificationSetting from './notification';
import Other from './other';
import About from './about';
import { useOutletContext } from '@umijs/max';
import { SharedContext } from '@/layouts';
import './index.less';
import useResizeObserver from '@react-hook/resize-observer';
import SystemLog from './systemLog';
import Dependence from './dependence';

const { Text } = Typography;
const isDemoEnv = window.__ENV__DeployEnv === 'demo';

const Setting = () => {
  const {
    headerStyle,
    isPhone,
    user,
    theme,
    reloadUser,
    reloadTheme,
    systemInfo,
  } = useOutletContext<SharedContext>();
  const columns = [
    {
      title: intl.get('名称'),
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Client ID',
      dataIndex: 'client_id',
      key: 'client_id',
      render: (text: string, record: any) => {
        return <Text copyable>{record.client_id}</Text>;
      },
    },
    {
      title: 'Client Secret',
      dataIndex: 'client_secret',
      key: 'client_secret',
      render: (text: string, record: any) => {
        return <Text copyable={{ text: record.client_secret }}>*******</Text>;
      },
    },
    {
      title: intl.get('权限'),
      dataIndex: 'scopes',
      key: 'scopes',
      width: 500,
      render: (text: string, record: any) => {
        return (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {record.scopes.map((scope: any) => {
              return (
                <Tag style={{ marginRight: 0 }} key={scope}>
                  {(config.scopesMap as any)[scope]}
                </Tag>
              );
            })}
          </div>
        );
      },
    },
    {
      title: intl.get('操作'),
      key: 'action',
      render: (text: string, record: any, index: number) => {
        const isPc = !isPhone;
        return (
          <Space size="middle" style={{ paddingLeft: 8 }}>
            <Tooltip title={isPc ? intl.get('编辑') : ''}>
              <a onClick={() => editApp(record, index)}>
                <EditOutlined />
              </a>
            </Tooltip>
            <Tooltip title={isPc ? intl.get('重置secret') : ''}>
              <a onClick={() => resetSecret(record, index)}>
                <ReloadOutlined />
              </a>
            </Tooltip>
            <Tooltip title={isPc ? intl.get('删除') : ''}>
              <a onClick={() => deleteApp(record, index)}>
                <DeleteOutlined />
              </a>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  const [loading, setLoading] = useState(true);
  const [dataSource, setDataSource] = useState<any[]>([]);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editedApp, setEditedApp] = useState<any>();
  const [tabActiveKey, setTabActiveKey] = useState('security');
  const [loginLogData, setLoginLogData] = useState<any[]>([]);
  const [systemLogData, setSystemLogData] = useState<string>('');
  const [notificationInfo, setNotificationInfo] = useState<any>();
  const containergRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>(0);

  useResizeObserver(containergRef, (entry) => {
    const _height = entry.target.parentElement?.parentElement?.offsetHeight;
    if (_height && height !== _height - 66) {
      setHeight(_height - 66);
    }
  });

  const getApps = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}apps`)
      .then(({ code, data }) => {
        if (code === 200) {
          setDataSource(data);
        }
      })
      .finally(() => setLoading(false));
  };

  const addApp = () => {
    setEditedApp(null);
    setIsModalVisible(true);
  };

  const editApp = (record: any, index: number) => {
    setEditedApp(record);
    setIsModalVisible(true);
  };

  const deleteApp = (record: any, index: number) => {
    Modal.confirm({
      title: intl.get('确认删除'),
      content: (
        <>
          {intl.get('确认删除应用')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}apps`, { data: [record.id] })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success(intl.get('删除成功'));
              const result = [...dataSource];
              result.splice(index, 1);
              setDataSource(result);
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const resetSecret = (record: any, index: number) => {
    Modal.confirm({
      title: intl.get('确认重置'),
      content: (
        <>
          {intl.get('确认重置应用')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('的Secret吗')}
          <br />
          <Text type="secondary">
            {intl.get('重置Secret会让当前应用所有token失效')}
          </Text>
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}apps/${record.id}/reset-secret`)
          .then(({ code, data }) => {
            if (code === 200) {
              message.success(intl.get('重置成功'));
              handleApp(data);
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const handleCancel = (app?: any) => {
    setIsModalVisible(false);
    if (app) {
      handleApp(app);
    }
  };

  const handleApp = (app: any) => {
    const index = dataSource.findIndex((x) => x.id === app.id);
    const result = [...dataSource];
    if (index === -1) {
      result.push(app);
    } else {
      result.splice(index, 1, {
        ...app,
      });
    }
    setDataSource(result);
  };

  const getLoginLog = () => {
    request
      .get(`${config.apiPrefix}user/login-log`)
      .then(({ code, data }) => {
        if (code === 200) {
          setLoginLogData(data);
        }
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const getSystemLog = () => {
    request
      .get<Blob>(`${config.apiPrefix}system/log`, {
        responseType: 'blob',
      })
      .then(async (res) => {
        setSystemLogData(await res.text());
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const tabChange = (activeKey: string) => {
    setTabActiveKey(activeKey);
    if (activeKey === 'app') {
      getApps();
    } else if (activeKey === 'login') {
      getLoginLog();
    } else if (activeKey === 'notification') {
      getNotification();
    } else if (activeKey === 'syslog') {
      getSystemLog();
    }
  };

  const getNotification = () => {
    request
      .get(`${config.apiPrefix}user/notification`)
      .then(({ code, data }) => {
        if (code === 200) {
          setNotificationInfo(data);
        }
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  useEffect(() => {
    if (isDemoEnv) {
      getApps();
    }
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper ql-container-wrapper-has-tab ql-setting-container"
      title={intl.get('系统设置')}
      header={{
        style: headerStyle,
      }}
      extra={
        tabActiveKey === 'app'
          ? [
              <Button key="2" type="primary" onClick={() => addApp()}>
                {intl.get('创建应用')}
              </Button>,
            ]
          : []
      }
    >
      <div ref={containergRef}>
        <Tabs
          defaultActiveKey="security"
          size="small"
          tabPosition="top"
          onChange={tabChange}
          items={[
            ...(!isDemoEnv
              ? [
                  {
                    key: 'security',
                    label: intl.get('安全设置'),
                    children: (
                      <SecuritySettings user={user} userChange={reloadUser} />
                    ),
                  },
                ]
              : []),
            {
              key: 'app',
              label: intl.get('应用设置'),
              children: (
                <Table
                  columns={columns}
                  pagination={false}
                  dataSource={dataSource}
                  rowKey="id"
                  size="middle"
                  scroll={{ x: 1000 }}
                  loading={loading}
                />
              ),
            },
            {
              key: 'notification',
              label: intl.get('通知设置'),
              children: <NotificationSetting data={notificationInfo} />,
            },
            {
              key: 'syslog',
              label: intl.get('系统日志'),
              children: (
                <SystemLog data={systemLogData} height={height} theme={theme} />
              ),
            },
            {
              key: 'login',
              label: intl.get('登录日志'),
              children: <LoginLog data={loginLogData} />,
            },
            {
              key: 'dependence',
              label: intl.get('依赖设置'),
              children: <Dependence />,
            },
            {
              key: 'other',
              label: intl.get('其他设置'),
              children: (
                <Other reloadTheme={reloadTheme} systemInfo={systemInfo} />
              ),
            },
            {
              key: 'about',
              label: intl.get('关于'),
              children: <About systemInfo={systemInfo} />,
            },
          ]}
        ></Tabs>
      </div>
      <AppModal
        visible={isModalVisible}
        handleCancel={handleCancel}
        app={editedApp}
      />
    </PageContainer>
  );
};

export default Setting;
