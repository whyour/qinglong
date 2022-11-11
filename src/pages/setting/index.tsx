import React, { useState, useEffect } from 'react';
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
import * as DarkReader from '@umijs/ssr-darkreader';
import AppModal from './appModal';
import {
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import SecuritySettings from './security';
import LoginLog from './loginLog';
import NotificationSetting from './notification';
import CheckUpdate from './checkUpdate';
import About from './about';
import { useOutletContext } from '@umijs/max';
import { SharedContext } from '@/layouts';
import './index.less'

const { Text } = Typography;
const optionsWithDisabled = [
  { label: '亮色', value: 'light' },
  { label: '暗色', value: 'dark' },
  { label: '跟随系统', value: 'auto' },
];

const Setting = () => {
  const {
    headerStyle,
    isPhone,
    user,
    reloadUser,
    reloadTheme,
    socketMessage,
    systemInfo,
  } = useOutletContext<SharedContext>();
  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      align: 'center' as const,
    },
    {
      title: 'Client ID',
      dataIndex: 'client_id',
      key: 'client_id',
      align: 'center' as const,
      render: (text: string, record: any) => {
        return <Text copyable>{record.client_id}</Text>;
      },
    },
    {
      title: 'Client Secret',
      dataIndex: 'client_secret',
      key: 'client_secret',
      align: 'center' as const,
      render: (text: string, record: any) => {
        return <Text copyable={{ text: record.client_secret }}>*******</Text>;
      },
    },
    {
      title: '权限',
      dataIndex: 'scopes',
      key: 'scopes',
      align: 'center' as const,
      render: (text: string, record: any) => {
        return record.scopes.map((scope: any) => {
          return <Tag key={scope}>{(config.scopesMap as any)[scope]}</Tag>;
        });
      },
    },
    {
      title: '操作',
      key: 'action',
      align: 'center' as const,
      render: (text: string, record: any, index: number) => {
        const isPc = !isPhone;
        return (
          <Space size="middle" style={{ paddingLeft: 8 }}>
            <Tooltip title={isPc ? '编辑' : ''}>
              <a onClick={() => editApp(record, index)}>
                <EditOutlined />
              </a>
            </Tooltip>
            <Tooltip title={isPc ? '重置secret' : ''}>
              <a onClick={() => resetSecret(record, index)}>
                <ReloadOutlined />
              </a>
            </Tooltip>
            <Tooltip title={isPc ? '删除' : ''}>
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
  const defaultTheme = localStorage.getItem('qinglong_dark_theme') || 'auto';
  const [dataSource, setDataSource] = useState<any[]>([]);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editedApp, setEditedApp] = useState<any>();
  const [tabActiveKey, setTabActiveKey] = useState('security');
  const [loginLogData, setLoginLogData] = useState<any[]>([]);
  const [notificationInfo, setNotificationInfo] = useState<any>();
  const [logRemoveFrequency, setLogRemoveFrequency] = useState<number>();
  const [form] = Form.useForm();
  const {
    enable: enableDarkMode,
    disable: disableDarkMode,
    exportGeneratedCSS: collectCSS,
    setFetchMethod,
    auto: followSystemColorScheme,
  } = DarkReader || {};

  const themeChange = (e: any) => {
    const _theme = e.target.value;
    localStorage.setItem('qinglong_dark_theme', e.target.value);
    setFetchMethod(fetch);

    if (_theme === 'dark') {
      enableDarkMode({});
    } else if (_theme === 'light') {
      disableDarkMode();
    } else {
      followSystemColorScheme({});
    }
    reloadTheme();
  };

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
      title: '确认删除',
      content: (
        <>
          确认删除应用{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}apps`, { data: [record.id] })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success('删除成功');
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
      title: '确认重置',
      content: (
        <>
          确认重置应用{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          的Secret吗
          <br />
          <Text type="secondary">重置Secret会让当前应用所有token失效</Text>
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}apps/${record.id}/reset-secret`)
          .then(({ code, data }) => {
            if (code === 200) {
              message.success('重置成功');
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

  const tabChange = (activeKey: string) => {
    setTabActiveKey(activeKey);
    if (activeKey === 'app') {
      getApps();
    } else if (activeKey === 'login') {
      getLoginLog();
    } else if (activeKey === 'notification') {
      getNotification();
    } else if (activeKey === 'other') {
      getLogRemoveFrequency();
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

  const getLogRemoveFrequency = () => {
    request
      .get(`${config.apiPrefix}system/log/remove`)
      .then(({ code, data }) => {
        if (code === 200 && data.info) {
          const { frequency } = data.info;
          setLogRemoveFrequency(frequency);
        }
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const updateRemoveLogFrequency = () => {
    setTimeout(() => {
      request
        .put(`${config.apiPrefix}system/log/remove`, {
          data: { frequency: logRemoveFrequency },
        })
        .then(({ code, data }) => {
          if (code === 200) {
            message.success('更新成功');
          }
        })
        .catch((error: any) => {
          console.log(error);
        });
    });
  };

  return (
    <PageContainer
      className="ql-container-wrapper ql-container-wrapper-has-tab ql-setting-container"
      title="系统设置"
      header={{
        style: headerStyle,
      }}
      extra={
        tabActiveKey === 'app'
          ? [
              <Button key="2" type="primary" onClick={() => addApp()}>
                新建应用
              </Button>,
            ]
          : []
      }
    >
      <Tabs
        defaultActiveKey="security"
        size="small"
        tabPosition="top"
        onChange={tabChange}
        items={[
          {
            key: 'security',
            label: '安全设置',
            children: <SecuritySettings user={user} userChange={reloadUser} />,
          },
          {
            key: 'app',
            label: '应用设置',
            children: (
              <Table
                columns={columns}
                pagination={false}
                dataSource={dataSource}
                rowKey="id"
                size="middle"
                scroll={{ x: 768 }}
                loading={loading}
              />
            ),
          },
          {
            key: 'notification',
            label: '通知设置',
            children: <NotificationSetting data={notificationInfo} />,
          },
          {
            key: 'login',
            label: '登录日志',
            children: <LoginLog data={loginLogData} />,
          },
          {
            key: 'other',
            label: '其他设置',
            children: (
              <Form layout="vertical" form={form}>
                <Form.Item
                  label="主题设置"
                  name="theme"
                  initialValue={defaultTheme}
                >
                  <Radio.Group
                    options={optionsWithDisabled}
                    onChange={themeChange}
                    value={defaultTheme}
                    optionType="button"
                    buttonStyle="solid"
                  />
                </Form.Item>
                <Form.Item
                  label="日志删除频率"
                  name="frequency"
                  tooltip="每x天自动删除x天以前的日志"
                >
                  <Input.Group compact>
                    <InputNumber
                      addonBefore="每"
                      addonAfter="天"
                      style={{ width: 150 }}
                      min={0}
                      value={logRemoveFrequency}
                      onChange={(value) => setLogRemoveFrequency(value)}
                    />
                    <Button type="primary" onClick={updateRemoveLogFrequency}>
                      确认
                    </Button>
                  </Input.Group>
                </Form.Item>
                <Form.Item label="检查更新" name="update">
                  <CheckUpdate socketMessage={socketMessage} />
                </Form.Item>
              </Form>
            ),
          },
          {
            key: 'about',
            label: '关于',
            children: <About systemInfo={systemInfo} />,
          },
        ]}
      ></Tabs>
      <AppModal
        visible={isModalVisible}
        handleCancel={handleCancel}
        app={editedApp}
      />
    </PageContainer>
  );
};

export default Setting;
