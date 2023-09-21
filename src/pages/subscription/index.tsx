import intl from 'react-intl-universal';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Button,
  message,
  Modal,
  Table,
  Tag,
  Space,
  Dropdown,
  Menu,
  Typography,
  Input,
  Tooltip,
  Checkbox,
} from 'antd';
import {
  ClockCircleOutlined,
  Loading3QuartersOutlined,
  CloseCircleOutlined,
  EllipsisOutlined,
  CheckCircleOutlined,
  EditOutlined,
  StopOutlined,
  DeleteOutlined,
  FileTextOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import SubscriptionModal from './modal';
import { history, useOutletContext } from '@umijs/max';
import './index.less';
import SubscriptionLogModal from './logModal';
import { SharedContext } from '@/layouts';
import useTableScrollHeight from '@/hooks/useTableScrollHeight';
import WebSocketManager from '@/utils/websocket';

const { Text, Paragraph } = Typography;
const { Search } = Input;

export enum SubscriptionStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}

export enum IntervalSchedule {
  'days' = '天',
  'hours' = '时',
  'minutes' = '分',
  'seconds' = '秒',
}

export enum SubscriptionType {
  'private-repo' = '私有仓库',
  'public-repo' = '公开仓库',
  'file' = '单文件',
}

const Subscription = () => {
  const { headerStyle, isPhone } = useOutletContext<SharedContext>();

  const columns: any = [
    {
      title: intl.get('名称'),
      dataIndex: 'name',
      key: 'name',
      width: 150,
      sorter: {
        compare: (a: any, b: any) => a.name.localeCompare(b.name),
        multiple: 2,
      },
    },
    {
      title: intl.get('链接'),
      dataIndex: 'url',
      key: 'url',
      sorter: {
        compare: (a: any, b: any) => a.name.localeCompare(b.name),
        multiple: 2,
      },
      render: (text: string, record: any) => {
        return (
          <Paragraph
            style={{
              wordBreak: 'break-all',
              marginBottom: 0,
            }}
            ellipsis={{ tooltip: text, rows: 2 }}
          >
            {text}
          </Paragraph>
        );
      },
    },
    {
      title: intl.get('类型'),
      dataIndex: 'type',
      key: 'type',
      width: 130,
      render: (text: string, record: any) => {
        return (SubscriptionType as any)[record.type];
      },
    },
    {
      title: intl.get('分支'),
      dataIndex: 'branch',
      key: 'branch',
      width: 130,
      render: (text: string, record: any) => {
        return record.branch || '-';
      },
    },
    {
      title: intl.get('定时规则'),
      width: 180,
      render: (text: string, record: any) => {
        if (record.schedule_type === 'interval') {
          const { type, value } = record.interval_schedule;
          return `每${value}${(IntervalSchedule as any)[type]}`;
        }
        return record.schedule;
      },
    },
    {
      title: intl.get('状态'),
      key: 'status',
      dataIndex: 'status',
      width: 110,
      filters: [
        {
          text: intl.get('运行中'),
          value: 0,
        },
        {
          text: intl.get('空闲中'),
          value: 1,
        },
        {
          text: intl.get('已禁用'),
          value: 2,
        },
      ],
      onFilter: (value: number, record: any) => {
        if (record.is_disabled && record.status !== 0) {
          return value === 2;
        } else {
          return record.status === value;
        }
      },
      render: (text: string, record: any) => (
        <>
          {(!record.is_disabled ||
            record.status !== SubscriptionStatus.idle) && (
            <>
              {record.status === SubscriptionStatus.idle && (
                <Tag icon={<ClockCircleOutlined />} color="default">
                  {intl.get('空闲中')}
                </Tag>
              )}
              {record.status === SubscriptionStatus.running && (
                <Tag
                  icon={<Loading3QuartersOutlined spin />}
                  color="processing"
                >
                  {intl.get('运行中')}
                </Tag>
              )}
            </>
          )}
          {record.is_disabled === 1 &&
            record.status === SubscriptionStatus.idle && (
              <Tag icon={<CloseCircleOutlined />} color="error">
                {intl.get('已禁用')}
              </Tag>
            )}
        </>
      ),
    },
    {
      title: intl.get('操作'),
      key: 'action',
      width: 140,
      render: (text: string, record: any, index: number) => {
        const isPc = !isPhone;
        return (
          <Space size="middle">
            {record.status === SubscriptionStatus.idle && (
              <a
                onClick={(e) => {
                  e.stopPropagation();
                  runSubscription(record, index);
                }}
              >
                {intl.get('运行')}
              </a>
            )}
            {record.status !== SubscriptionStatus.idle && (
              <a
                onClick={(e) => {
                  e.stopPropagation();
                  stopSubsciption(record, index);
                }}
              >
                {intl.get('停止')}
              </a>
            )}
            <a
              onClick={(e) => {
                e.stopPropagation();
                setLogSubscription({ ...record, timestamp: Date.now() });
              }}
            >
              {intl.get('日志')}
            </a>
            <MoreBtn key="more" record={record} index={index} />
          </Space>
        );
      },
    },
  ];

  const [value, setValue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editedSubscription, setEditedSubscription] = useState();
  const [searchText, setSearchText] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logSubscription, setLogSubscription] = useState<any>();
  const tableRef = useRef<HTMLDivElement>(null);
  const tableScrollHeight = useTableScrollHeight(tableRef);
  const deleteCheckRef = useRef(false);

  const runSubscription = (record: any, index: number) => {
    Modal.confirm({
      title: intl.get('确认运行'),
      content: (
        <>
          {intl.get('确认运行定时任务')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}subscriptions/run`, [record.id])
          .then(({ code, data }) => {
            if (code === 200) {
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              if (i !== -1) {
                result.splice(i, 1, {
                  ...record,
                  status: SubscriptionStatus.running,
                });
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

  const stopSubsciption = (record: any, index: number) => {
    Modal.confirm({
      title: intl.get('确认停止'),
      content: (
        <>
          {intl.get('确认停止定时任务')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}subscriptions/stop`, [record.id])
          .then(({ code, data }) => {
            if (code === 200) {
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              if (i !== -1) {
                result.splice(i, 1, {
                  ...record,
                  pid: null,
                  status: SubscriptionStatus.idle,
                });
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

  const getSubscriptions = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}subscriptions?searchValue=${searchText}`)
      .then(({ code, data }) => {
        if (code === 200) {
          setValue(data);
          setCurrentPage(1);
        }
      })
      .finally(() => setLoading(false));
  };

  const addSubscription = () => {
    setEditedSubscription(null as any);
    setIsModalVisible(true);
  };

  const editSubscription = (record: any, index: number) => {
    setEditedSubscription(record);
    setIsModalVisible(true);
  };

  const onCheckChange = (e) => {
    deleteCheckRef.current = e.target.checked;
  };

  const delSubscription = (record: any, index: number) => {
    Modal.confirm({
      title: intl.get('确认删除'),
      content: (
        <>
          {intl.get('确认删除定时订阅')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
          <div style={{ marginTop: 20 }}>
            <Checkbox onChange={onCheckChange}>
              {intl.get('同时删除关联任务和脚本')}
            </Checkbox>
          </div>
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}subscriptions`, {
            data: [record.id],
            params: { force: deleteCheckRef.current },
          })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success(intl.get('删除成功'));
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              if (i !== -1) {
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

  const enabledOrDisabledSubscription = (record: any, index: number) => {
    Modal.confirm({
      title: `确认${
        record.is_disabled === 1 ? intl.get('启用') : intl.get('禁用')
      }`,
      content: (
        <>
          {intl.get('确认')}
          {record.is_disabled === 1 ? intl.get('启用') : intl.get('禁用')}
          {intl.get('定时订阅')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}subscriptions/${
              record.is_disabled === 1 ? 'enable' : 'disable'
            }`,
            [record.id],
          )
          .then(({ code, data }) => {
            if (code === 200) {
              const newStatus = record.is_disabled === 1 ? 0 : 1;
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              if (i !== -1) {
                result.splice(i, 1, {
                  ...record,
                  is_disabled: newStatus,
                });
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

  const MoreBtn: React.FC<{
    record: any;
    index: number;
  }> = ({ record, index }) => (
    <Dropdown
      placement="bottomRight"
      trigger={['click']}
      menu={{
        items: [
          { label: intl.get('编辑'), key: 'edit', icon: <EditOutlined /> },
          {
            label:
              record.is_disabled === 1 ? intl.get('启用') : intl.get('禁用'),
            key: 'enableOrDisable',
            icon:
              record.is_disabled === 1 ? (
                <CheckCircleOutlined />
              ) : (
                <StopOutlined />
              ),
          },
          { label: intl.get('删除'), key: 'delete', icon: <DeleteOutlined /> },
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          action(key, record, index);
        },
      }}
    >
      <a onClick={(e) => e.stopPropagation()}>
        <EllipsisOutlined />
      </a>
    </Dropdown>
  );

  const action = (key: string | number, record: any, index: number) => {
    switch (key) {
      case 'edit':
        editSubscription(record, index);
        break;
      case 'enableOrDisable':
        enabledOrDisabledSubscription(record, index);
        break;
      case 'delete':
        delSubscription(record, index);
        break;
      default:
        break;
    }
  };

  const handleCancel = (subscription?: any) => {
    setIsModalVisible(false);
    if (subscription) {
      handleSubscriptions(subscription);
    }
  };

  const onSearch = (value: string) => {
    setSearchText(value.trim());
  };

  const handleSubscriptions = (subscription: any) => {
    const index = value.findIndex((x) => x.id === subscription.id);
    const result = [...value];
    if (index === -1) {
      result.unshift(subscription);
    } else {
      result.splice(index, 1, {
        ...subscription,
      });
    }
    setValue(result);
  };

  const onPageChange = (page: number, pageSize: number | undefined) => {
    setCurrentPage(page);
    setPageSize(pageSize as number);
    localStorage.setItem('pageSize', pageSize + '');
  };

  const getRowClassName = (record: any, index: number) => {
    return record.isPinned
      ? 'pinned-subscription subscription'
      : 'subscription';
  };

  const handleMessage = useCallback((payload: any) => {
    const { message, references } = payload;
    setValue((p) => {
      const result = [...p];
      for (let i = 0; i < references.length; i++) {
        const index = p.findIndex((x) => x.id === references[i]);
        if (index !== -1) {
          result.splice(index, 1, {
            ...p[index],
            status: SubscriptionStatus.idle,
          });
        }
      }
      return result;
    });
  }, []);

  useEffect(() => {
    const ws = WebSocketManager.getInstance();
    ws.subscribe('runSubscriptionEnd', handleMessage);

    return () => {
      ws.unsubscribe('runSubscriptionEnd', handleMessage);
    };
  }, []);

  useEffect(() => {
    if (logSubscription) {
      localStorage.setItem('logSubscription', logSubscription.id);
      setIsLogModalVisible(true);
    }
  }, [logSubscription]);

  useEffect(() => {
    getSubscriptions();
  }, [searchText]);

  useEffect(() => {
    setPageSize(parseInt(localStorage.getItem('pageSize') || '20'));
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper subscriptiontab-wrapper"
      title={intl.get('订阅管理')}
      extra={[
        <Search
          placeholder={intl.get('请输入名称或者关键词')}
          style={{ width: 'auto' }}
          enterButton
          allowClear
          loading={loading}
          onSearch={onSearch}
        />,
        <Button key="2" type="primary" onClick={() => addSubscription()}>
          {intl.get('创建订阅')}
        </Button>,
      ]}
      header={{
        style: headerStyle,
      }}
    >
      <Table
        ref={tableRef}
        columns={columns}
        pagination={{
          current: currentPage,
          onChange: onPageChange,
          pageSize: pageSize,
          showSizeChanger: true,
          simple: isPhone,
          defaultPageSize: 20,
          showTotal: (total: number, range: number[]) =>
            `第 ${range[0]}-${range[1]} 条/总共 ${total} 条`,
          pageSizeOptions: [20, 100, 500, 1000] as any,
        }}
        dataSource={value}
        rowKey="id"
        size="middle"
        scroll={{ x: 1000, y: tableScrollHeight }}
        loading={loading}
        rowClassName={getRowClassName}
      />
      <SubscriptionModal
        visible={isModalVisible}
        handleCancel={handleCancel}
        subscription={editedSubscription}
      />
      <SubscriptionLogModal
        visible={isLogModalVisible}
        handleCancel={() => {
          setIsLogModalVisible(false);
        }}
        subscription={logSubscription}
      />
    </PageContainer>
  );
};

export default Subscription;
