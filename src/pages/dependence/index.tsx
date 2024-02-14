import intl from 'react-intl-universal';
import React, { useCallback, useRef, useState, useEffect } from 'react';
import {
  Button,
  message,
  Modal,
  Table,
  Tag,
  Space,
  Typography,
  Tooltip,
  Input,
  Tabs,
} from 'antd';
import {
  EditOutlined,
  DeleteOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  DeleteFilled,
  BugOutlined,
  FileTextOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import DependenceModal from './modal';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import './index.less';
import DependenceLogModal from './logModal';
import { useOutletContext } from '@umijs/max';
import { SharedContext } from '@/layouts';
import useTableScrollHeight from '@/hooks/useTableScrollHeight';
import dayjs from 'dayjs';
import WebSocketManager from '@/utils/websocket';
import { DependenceStatus, Status } from './type';
import IconFont from '@/components/iconfont';

const { Text } = Typography;
const { Search } = Input;

enum StatusColor {
  'processing',
  'success',
  'error',
}

const StatusMap: Record<number, { icon: React.ReactNode; color: string }> = {
  0: {
    icon: <SyncOutlined spin />,
    color: 'processing',
  },
  1: {
    icon: <CheckCircleOutlined />,
    color: 'success',
  },
  2: {
    icon: <CloseCircleOutlined />,
    color: 'error',
  },
  3: {
    icon: <SyncOutlined spin />,
    color: 'processing',
  },
  4: {
    icon: <CheckCircleOutlined />,
    color: 'success',
  },
  5: {
    icon: <CloseCircleOutlined />,
    color: 'error',
  },
  6: {
    icon: <ClockCircleOutlined />,
    color: 'default',
  },
  7: {
    icon: <MinusCircleOutlined />,
    color: 'default',
  },
};

const Dependence = () => {
  const { headerStyle, isPhone } = useOutletContext<SharedContext>();
  const columns: any = [
    {
      title: intl.get('序号'),
      width: 90,
      render: (text: string, record: any, index: number) => {
        return <span style={{ cursor: 'text' }}>{index + 1} </span>;
      },
    },
    {
      title: intl.get('名称'),
      dataIndex: 'name',
      width: 180,
      key: 'name',
    },
    {
      title: intl.get('状态'),
      key: 'status',
      width: 120,
      dataIndex: 'status',
      filters: [
        {
          text: intl.get('队列中'),
          value: DependenceStatus.queued,
        },
        {
          text: intl.get('安装中'),
          value: DependenceStatus.installing,
        },
        {
          text: intl.get('已安装'),
          value: DependenceStatus.installed,
        },
        {
          text: intl.get('安装失败'),
          value: DependenceStatus.installFailed,
        },
        {
          text: intl.get('删除中'),
          value: DependenceStatus.removing,
        },
        {
          text: intl.get('已删除'),
          value: DependenceStatus.removed,
        },
        {
          text: intl.get('删除失败'),
          value: DependenceStatus.removeFailed,
        },
        {
          text: intl.get('已取消'),
          value: DependenceStatus.cancelled,
        },
      ],
      render: (text: string, record: any, index: number) => {
        return (
          <Space size="middle" style={{ cursor: 'text' }}>
            <Tag
              color={StatusMap[record.status]?.color}
              icon={StatusMap[record.status]?.icon}
              style={{ marginRight: 0 }}
            >
              {intl.get(Status[record.status])}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: intl.get('备注'),
      dataIndex: 'remark',
      width: 100,
      key: 'remark',
    },
    {
      title: intl.get('更新时间'),
      key: 'updatedAt',
      dataIndex: 'updatedAt',
      width: 150,
      render: (text: string) => {
        return <span>{dayjs(text).format('YYYY-MM-DD HH:mm:ss')}</span>;
      },
    },
    {
      title: intl.get('创建时间'),
      key: 'createdAt',
      dataIndex: 'createdAt',
      width: 150,
      render: (text: string) => {
        return <span>{dayjs(text).format('YYYY-MM-DD HH:mm:ss')}</span>;
      },
    },
    {
      title: intl.get('操作'),
      key: 'action',
      width: 140,
      render: (text: string, record: any, index: number) => {
        const isPc = !isPhone;
        return (
          <Space size="middle">
            {![Status.队列中, Status.已取消].includes(record.status) && (
              <Tooltip title={isPc ? intl.get('日志') : ''}>
                <a
                  onClick={() => {
                    setLogDependence({ ...record, timestamp: Date.now() });
                  }}
                >
                  <FileTextOutlined />
                </a>
              </Tooltip>
            )}
            {[Status.队列中, Status.安装中, Status.删除中].includes(
              record.status,
            ) ? (
              <Tooltip title={isPc ? intl.get('取消安装') : ''}>
                <a onClick={() => cancelDependence(record)}>
                  <IconFont type="ql-icon-quxiaoanzhuang" />
                </a>
              </Tooltip>
            ) : (
              <>
                <Tooltip title={isPc ? intl.get('重新安装') : ''}>
                  <a onClick={() => reInstallDependence(record, index)}>
                    <BugOutlined />
                  </a>
                </Tooltip>
                {Status.已安装 === record.status && (
                  <Tooltip title={isPc ? intl.get('删除') : ''}>
                    <a onClick={() => deleteDependence(record, index)}>
                      <DeleteOutlined />
                    </a>
                  </Tooltip>
                )}
                <Tooltip title={isPc ? intl.get('强制删除') : ''}>
                  <a onClick={() => deleteDependence(record, index, true)}>
                    <DeleteFilled />
                  </a>
                </Tooltip>
              </>
            )}
          </Space>
        );
      },
    },
  ];
  const [value, setValue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editedDependence, setEditedDependence] = useState();
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [logDependence, setLogDependence] = useState<any>();
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [type, setType] = useState('nodejs');
  const tableRef = useRef<HTMLDivElement>(null);
  const tableScrollHeight = useTableScrollHeight(tableRef, 59);

  const getDependencies = (status?: number[]) => {
    setLoading(true);
    request
      .get(
        `${
          config.apiPrefix
        }dependencies?searchValue=${searchText}&type=${type}&status=${
          status || ''
        }`,
      )
      .then(({ code, data }) => {
        if (code === 200) {
          setValue(data);
        }
      })
      .finally(() => setLoading(false));
  };

  const addDependence = () => {
    setEditedDependence(null as any);
    setIsModalVisible(true);
  };

  const editDependence = (record: any, index: number) => {
    setEditedDependence(record);
    setIsModalVisible(true);
  };

  const deleteDependence = (
    record: any,
    index: number,
    force: boolean = false,
  ) => {
    Modal.confirm({
      title: intl.get('确认删除'),
      content: (
        <>
          {intl.get('确认删除依赖')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}dependencies${force ? '/force' : ''}`, {
            data: [record.id],
          })
          .then(({ code, data }) => {
            if (code === 200 && force) {
              const i = value.findIndex((x) => x.id === data[0].id);
              if (i !== -1) {
                const result = [...value];
                result.splice(i, 1);
                setValue(result);
              }
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const reInstallDependence = (record: any, index: number) => {
    Modal.confirm({
      title: intl.get('确认重新安装'),
      content: (
        <>
          {intl.get('确认重新安装')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}dependencies/reinstall`, [record.id])
          .then(({ code, data }) => {
            if (code === 200) {
              handleDependence(data[0]);
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const cancelDependence = (record: any) => {
    Modal.confirm({
      title: intl.get('确认取消安装'),
      content: (
        <>
          {intl.get('确认取消安装')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}dependencies/cancel`, [record.id])
          .then(() => {
            getDependencies();
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const handleCancel = (dependence?: any[]) => {
    setIsModalVisible(false);
    dependence && handleDependence(dependence);
  };

  const handleDependence = (dependence: any) => {
    const result = [...value];
    if (Array.isArray(dependence)) {
      result.unshift(...dependence);
    } else {
      const index = value.findIndex((x) => x.id === dependence.id);
      if (index !== -1) {
        result.splice(index, 1, {
          ...dependence,
        });
      }
    }
    setValue(result);
  };

  const onSelectChange = (selectedIds: any[]) => {
    setSelectedRowIds(selectedIds);
  };

  const rowSelection = {
    selectedRowKeys: selectedRowIds,
    onChange: onSelectChange,
  };

  const delDependencies = (force: boolean) => {
    const forceUrl = force ? '/force' : '';
    Modal.confirm({
      title: intl.get('确认删除'),
      content: <>{intl.get('确认删除选中的依赖吗')}</>,
      onOk() {
        request
          .delete(`${config.apiPrefix}dependencies${forceUrl}`, {
            data: selectedRowIds,
          })
          .then(({ code, data }) => {
            if (code === 200) {
              setSelectedRowIds([]);
              getDependencies();
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const handlereInstallDependencies = () => {
    Modal.confirm({
      title: intl.get('确认重新安装'),
      content: <>{intl.get('确认重新安装选中的依赖吗')}</>,
      onOk() {
        request
          .put(`${config.apiPrefix}dependencies/reinstall`, selectedRowIds)
          .then(({ code, data }) => {
            if (code === 200) {
              setSelectedRowIds([]);
              getDependencies();
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const getDependenceDetail = (dependence: any) => {
    request
      .get(`${config.apiPrefix}dependencies/${dependence.id}`)
      .then(({ code, data }) => {
        if (code === 200) {
          const index = value.findIndex((x) => x.id === dependence.id);
          const result = [...value];
          if (index !== -1) {
            result.splice(index, 1, {
              ...dependence,
              ...data,
            });
            setValue(result);
          }
        }
      })
      .finally(() => setLoading(false));
  };

  const onSearch = (value: string) => {
    setSearchText(value.trim());
  };

  useEffect(() => {
    getDependencies();
  }, [searchText, type]);

  useEffect(() => {
    if (logDependence) {
      localStorage.setItem('logDependence', logDependence.id);
      setIsLogModalVisible(true);
    }
  }, [logDependence]);

  const handleMessage = useCallback((payload: any) => {
    const { message, references } = payload;
    let status: number | undefined = undefined;
    if (message.includes('开始时间') && references.length > 0) {
      status = message.includes('安装') ? Status.安装中 : Status.删除中;
    }
    if (message.includes('结束时间') && references.length > 0) {
      if (message.includes('安装')) {
        status = message.includes('成功') ? Status.已安装 : Status.安装失败;
      } else {
        status = message.includes('成功') ? Status.已删除 : Status.删除失败;
      }

      if (status === Status.已删除) {
        setTimeout(() => {
          setValue((p) => {
            const _result = [...p];
            for (let i = 0; i < references.length; i++) {
              const index = p.findIndex((x) => x.id === references[i]);
              if (index !== -1) {
                _result.splice(index, 1);
              }
            }
            return _result;
          });
        }, 300);
        return;
      }
    }
    if (typeof status === 'number') {
      setValue((p) => {
        const result = [...p];
        for (let i = 0; i < references.length; i++) {
          const index = p.findIndex((x) => x.id === references[i]);
          if (index !== -1) {
            result.splice(index, 1, {
              ...p[index],
              status,
            });
          }
        }
        return result;
      });
    }
  }, []);

  useEffect(() => {
    const ws = WebSocketManager.getInstance();
    ws.subscribe('installDependence', handleMessage);
    ws.subscribe('uninstallDependence', handleMessage);

    return () => {
      ws.unsubscribe('installDependence', handleMessage);
      ws.unsubscribe('uninstallDependence', handleMessage);
    };
  }, []);

  const onTabChange = (activeKey: string) => {
    setSelectedRowIds([]);
    setType(activeKey);
  };

  return (
    <PageContainer
      className="ql-container-wrapper dependence-wrapper ql-container-wrapper-has-tab"
      title={intl.get('依赖管理')}
      extra={[
        <Search
          placeholder={intl.get('请输入名称')}
          style={{ width: 'auto' }}
          enterButton
          loading={loading}
          onSearch={onSearch}
        />,
        <Button key="2" type="primary" onClick={() => addDependence()}>
          {intl.get('创建依赖')}
        </Button>,
      ]}
      header={{
        style: headerStyle,
      }}
    >
      <Tabs
        defaultActiveKey="nodejs"
        size="small"
        tabPosition="top"
        onChange={onTabChange}
        items={[
          {
            key: 'nodejs',
            label: 'NodeJs',
          },
          {
            key: 'python3',
            label: 'Python3',
          },
          {
            key: 'linux',
            label: 'Linux',
          },
        ]}
      />
      <div ref={tableRef}>
        {selectedRowIds.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Button
              type="primary"
              style={{ marginBottom: 5, marginLeft: 8 }}
              onClick={() => handlereInstallDependencies()}
            >
              {intl.get('批量安装')}
            </Button>
            <Button
              type="primary"
              style={{ marginBottom: 5, marginLeft: 8 }}
              onClick={() => delDependencies(false)}
            >
              {intl.get('批量删除')}
            </Button>
            <Button
              type="primary"
              style={{ marginBottom: 5, marginLeft: 8 }}
              onClick={() => delDependencies(true)}
            >
              {intl.get('批量强制删除')}
            </Button>
            <span style={{ marginLeft: 8 }}>
              {intl.get('已选择')}
              <a>{selectedRowIds?.length}</a>
              {intl.get('项')}
            </span>
          </div>
        )}
        <DndProvider backend={HTML5Backend}>
          <Table
            columns={columns}
            rowSelection={rowSelection}
            pagination={false}
            dataSource={value}
            rowKey="id"
            size="middle"
            scroll={{ x: 768, y: tableScrollHeight }}
            loading={loading}
            onChange={(pagination, filters) => {
              getDependencies(filters?.status as number[]);
            }}
          />
        </DndProvider>
      </div>
      <DependenceModal
        visible={isModalVisible}
        handleCancel={handleCancel}
        dependence={editedDependence}
        defaultType={type}
      />
      {logDependence && (
        <DependenceLogModal
          visible={isLogModalVisible}
          handleCancel={(needRemove?: boolean) => {
            setIsLogModalVisible(false);
            if (needRemove) {
              const index = value.findIndex((x) => x.id === logDependence.id);
              const result = [...value];
              if (index !== -1) {
                result.splice(index, 1);
                setValue(result);
              }
            } else if ([...value].map((x) => x.id).includes(logDependence.id)) {
              getDependenceDetail(logDependence);
            }
          }}
          dependence={logDependence}
        />
      )}
    </PageContainer>
  );
};

export default Dependence;
