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
import useResizeObserver from '@react-hook/resize-observer';

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
  const [statusFilter, setStatusFilter] = useState<number[]>([]);
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
      filteredValue: statusFilter.length ? statusFilter : null,
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingType, setRefreshingType] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editedDependence, setEditedDependence] = useState();
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [logDependence, setLogDependence] = useState<any>();
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [type, setType] = useState('nodejs');
  const listQuery = useRef({ type, searchText, statusFilter });
  listQuery.current = { type, searchText, statusFilter };
  const tableRef = useRef<HTMLDivElement>(null);
  const latestListRequest = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const activeRefreshId = useRef<string | null>(null);
  const refreshRequestVersion = useRef(0);
  const alive = useRef(true);
  const [height, setHeight] = useState<number>(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      latestListRequest.current += 1;
      refreshRequestVersion.current += 1;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  useResizeObserver(tableRef, (entry) => {
    const _height =
      entry.target?.parentElement?.parentElement?.parentElement?.offsetHeight;
    let threshold = 113;
    if (selectedRowIds.length) {
      threshold += 53;
    }
    if (_height && height !== _height - threshold) {
      setHeight(_height - threshold);
    }
  });

  const getDependencies = (status?: number[]) => {
    const query = listQuery.current;
    const requestId = ++latestListRequest.current;
    setLoading(true);
    request
      .get(
        `${config.apiPrefix}dependencies?searchValue=${query.searchText}&type=${
          query.type
        }&status=${status ?? query.statusFilter}`,
      )
      .then(({ code, data }) => {
        if (
          alive.current &&
          requestId === latestListRequest.current &&
          code === 200
        ) {
          setValue(data);
        }
      })
      .finally(() => {
        if (alive.current && requestId === latestListRequest.current) {
          setLoading(false);
        }
      });
  };

  const scheduleRefresh = (callback: () => void, delay: number) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(callback, delay);
  };

  const finishRefresh = (id: string, completed: boolean) => {
    if (activeRefreshId.current !== id) return;
    refreshRequestVersion.current += 1;
    activeRefreshId.current = null;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    setRefreshing(false);
    setRefreshingType(null);
    setRefreshGeneration((generation) => generation + 1);
    if (!completed) {
      message.error(intl.get('依赖检查失败'));
    }
  };

  const attachRefresh = (job: { id: string; type: string }) => {
    if (!alive.current) return;
    refreshRequestVersion.current += 1;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    activeRefreshId.current = job.id;
    setRefreshing(true);
    setRefreshingType(job.type);
    scheduleRefresh(() => pollRefresh(job.id), 0);
  };

  const recoverRefresh = (
    reloadWhenIdle = false,
    retryOnError = false,
    notifyWhenIdle = false,
  ) => {
    const version = ++refreshRequestVersion.current;
    request
      .get(`${config.apiPrefix}dependencies/refresh/active`)
      .then(({ code, data }) => {
        if (!alive.current || version !== refreshRequestVersion.current) return;
        if (code === 200 && data) {
          attachRefresh(data);
        } else if (reloadWhenIdle) {
          activeRefreshId.current = null;
          setRefreshing(false);
          setRefreshingType(null);
          setRefreshGeneration((generation) => generation + 1);
          if (notifyWhenIdle) message.warning(intl.get('依赖检查状态已中断'));
        }
      })
      .catch(() => {
        if (
          alive.current &&
          version === refreshRequestVersion.current &&
          retryOnError
        ) {
          scheduleRefresh(() => {
            if (alive.current && version === refreshRequestVersion.current) {
              recoverRefresh(reloadWhenIdle, true, notifyWhenIdle);
            }
          }, 5000);
        }
      });
  };

  const pollRefresh = (id: string) => {
    request
      .get(`${config.apiPrefix}dependencies/refresh/${id}`)
      .then(({ code, data }) => {
        if (!alive.current || activeRefreshId.current !== id) return;
        if (code !== 200) {
          scheduleRefresh(() => pollRefresh(id), 5000);
          return;
        }
        if (data.state === 'running') {
          scheduleRefresh(() => pollRefresh(id), 2000);
        } else {
          finishRefresh(id, data.state === 'completed');
        }
      })
      .catch((error) => {
        if (!alive.current || activeRefreshId.current !== id) return;
        if (error?.response?.status === 404) {
          activeRefreshId.current = null;
          recoverRefresh(true, true, true);
        } else {
          scheduleRefresh(() => pollRefresh(id), 5000);
        }
      });
  };

  const startRefresh = () => {
    if (activeRefreshId.current) return;
    const version = ++refreshRequestVersion.current;
    setRefreshing(true);
    setRefreshingType(type);
    request
      .post(`${config.apiPrefix}dependencies/refresh`, { type })
      .then(({ code, data }) => {
        if (!alive.current || version !== refreshRequestVersion.current) return;
        if (code === 200) {
          attachRefresh(data);
        } else {
          recoverRefresh(true, true);
        }
      })
      .catch(() => {
        if (alive.current && version === refreshRequestVersion.current) {
          recoverRefresh(true, true);
        }
      });
  };

  useEffect(() => {
    recoverRefresh(false, true);
  }, []);

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
    const trimmed = value.trim();
    if (trimmed !== searchText) {
      latestListRequest.current += 1;
      setSearchText(trimmed);
    }
  };

  useEffect(() => {
    getDependencies();
  }, [searchText, type, refreshGeneration]);

  useEffect(() => {
    if (logDependence) {
      localStorage.setItem('logDependence', logDependence.id);
      setIsLogModalVisible(true);
    }
  }, [logDependence]);

  const handleMessage = useCallback((payload: any) => {
    const { references, status } = payload;
    if (typeof status !== 'number' || !references?.length) return;

    if (status === Status.已删除) {
      setTimeout(() => {
        setValue((p) => {
          const _result = [...p];
          for (const refId of references) {
            const index = p.findIndex((x) => x.id === refId);
            if (index !== -1) _result.splice(index, 1);
          }
          return _result;
        });
      }, 300);
      return;
    }

    setValue((p) => {
      const result = [...p];
      for (const refId of references) {
        const index = p.findIndex((x) => x.id === refId);
        if (index !== -1) {
          result.splice(index, 1, { ...p[index], status });
        }
      }
      return result;
    });
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
    latestListRequest.current += 1;
    setSelectedRowIds([]);
    setType(activeKey);
  };

  const children = (
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
            {intl.get('选中条数', { count: selectedRowIds.length })}
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
          scroll={{ x: 768, y: height }}
          loading={loading}
          onChange={(pagination, filters) => {
            const status = (filters?.status as number[]) || [];
            setStatusFilter(status);
            getDependencies(status);
          }}
        />
      </DndProvider>
    </div>
  );

  return (
    <PageContainer
      className="ql-container-wrapper dependence-wrapper ql-container-wrapper-has-tab"
      title={intl.get('依赖管理')}
      extra={[
        <Button
          key="refresh"
          icon={<SyncOutlined />}
          loading={refreshing}
          disabled={type === 'linux' || loading}
          onClick={startRefresh}
        >
          {refreshingType
            ? intl.get('正在检查依赖', {
                type: refreshingType === 'nodejs' ? 'Node' : 'Python',
              })
            : intl.get('重新检查依赖')}
        </Button>,
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
        destroyInactiveTabPane
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
      {children}
      {isModalVisible && (
        <DependenceModal
          handleCancel={handleCancel}
          dependence={editedDependence}
          defaultType={type}
        />
      )}
      {logDependence && isLogModalVisible && (
        <DependenceLogModal
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
