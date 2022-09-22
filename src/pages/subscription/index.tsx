import React, { useState, useEffect } from 'react';
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
import { getTableScroll } from '@/utils/index';
import { history, useOutletContext } from '@umijs/max';
import './index.less';
import SubscriptionLogModal from './logModal';
import { SharedContext } from '@/layouts';

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
  const { headerStyle, isPhone, socketMessage } =
    useOutletContext<SharedContext>();

  const columns: any = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 150,
      align: 'center' as const,
      sorter: {
        compare: (a: any, b: any) => a.name.localeCompare(b.name),
        multiple: 2,
      },
    },
    {
      title: '链接',
      dataIndex: 'url',
      key: 'url',
      align: 'center' as const,
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
              textAlign: 'left',
            }}
            ellipsis={{ tooltip: text, rows: 2 }}
          >
            {text}
          </Paragraph>
        );
      },
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 130,
      align: 'center' as const,
      render: (text: string, record: any) => {
        return (SubscriptionType as any)[record.type];
      },
    },
    {
      title: '分支',
      dataIndex: 'branch',
      key: 'branch',
      width: 130,
      align: 'center' as const,
      render: (text: string, record: any) => {
        return record.branch || '-';
      },
    },
    {
      title: '定时规则',
      width: 180,
      align: 'center' as const,
      render: (text: string, record: any) => {
        if (record.schedule_type === 'interval') {
          const { type, value } = record.interval_schedule;
          return `每${value}${(IntervalSchedule as any)[type]}`;
        }
        return record.schedule;
      },
    },
    {
      title: '状态',
      key: 'status',
      dataIndex: 'status',
      align: 'center' as const,
      width: 110,
      filters: [
        {
          text: '运行中',
          value: 0,
        },
        {
          text: '空闲中',
          value: 1,
        },
        {
          text: '已禁用',
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
                  空闲中
                </Tag>
              )}
              {record.status === SubscriptionStatus.running && (
                <Tag
                  icon={<Loading3QuartersOutlined spin />}
                  color="processing"
                >
                  运行中
                </Tag>
              )}
            </>
          )}
          {record.is_disabled === 1 &&
            record.status === SubscriptionStatus.idle && (
              <Tag icon={<CloseCircleOutlined />} color="error">
                已禁用
              </Tag>
            )}
        </>
      ),
    },
    {
      title: '操作',
      key: 'action',
      align: 'center' as const,
      width: 130,
      render: (text: string, record: any, index: number) => {
        const isPc = !isPhone;
        return (
          <Space size="middle">
            {record.status === SubscriptionStatus.idle && (
              <Tooltip title={isPc ? '运行' : ''}>
                <a
                  onClick={(e) => {
                    e.stopPropagation();
                    runSubscription(record, index);
                  }}
                >
                  <PlayCircleOutlined />
                </a>
              </Tooltip>
            )}
            {record.status !== SubscriptionStatus.idle && (
              <Tooltip title={isPc ? '停止' : ''}>
                <a
                  onClick={(e) => {
                    e.stopPropagation();
                    stopSubsciption(record, index);
                  }}
                >
                  <PauseCircleOutlined />
                </a>
              </Tooltip>
            )}
            <Tooltip title={isPc ? '日志' : ''}>
              <a
                onClick={(e) => {
                  e.stopPropagation();
                  setLogSubscription({ ...record, timestamp: Date.now() });
                }}
              >
                <FileTextOutlined />
              </a>
            </Tooltip>
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
  const [tableScrollHeight, setTableScrollHeight] = useState<number>();
  const [searchValue, setSearchValue] = useState('');
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logSubscription, setLogSubscription] = useState<any>();

  const runSubscription = (record: any, index: number) => {
    Modal.confirm({
      title: '确认运行',
      content: (
        <>
          确认运行定时任务{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}subscriptions/run`, { data: [record.id] })
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
      title: '确认停止',
      content: (
        <>
          确认停止定时任务{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}subscriptions/stop`, { data: [record.id] })
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

  const delSubscription = (record: any, index: number) => {
    Modal.confirm({
      title: '确认删除',
      content: (
        <>
          确认删除定时订阅{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}subscriptions`, { data: [record.id] })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success('删除成功');
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
      title: `确认${record.is_disabled === 1 ? '启用' : '禁用'}`,
      content: (
        <>
          确认{record.is_disabled === 1 ? '启用' : '禁用'}
          定时订阅{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}subscriptions/${
              record.is_disabled === 1 ? 'enable' : 'disable'
            }`,
            {
              data: [record.id],
            },
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
      arrow={{ pointAtCenter: true }}
      placement="bottomRight"
      trigger={['click']}
      overlay={
        <Menu
          items={[
            { label: '编辑', key: 'edit', icon: <EditOutlined /> },
            {
              label: record.is_disabled === 1 ? '启用' : '禁用',
              key: 'enableOrDisable',
              icon:
                record.is_disabled === 1 ? (
                  <CheckCircleOutlined />
                ) : (
                  <StopOutlined />
                ),
            },
            { label: '删除', key: 'delete', icon: <DeleteOutlined /> },
          ]}
          onClick={({ key, domEvent }) => {
            domEvent.stopPropagation();
            action(key, record, index);
          }}
        />
      }
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

  useEffect(() => {
    if (!socketMessage) return;
    const { type, message, references } = socketMessage;
    if (type === 'runSubscriptionEnd' && references.length > 0) {
      const result = [...value];
      for (let i = 0; i < references.length; i++) {
        const index = value.findIndex((x) => x.id === references[i]);
        if (index !== -1) {
          result.splice(index, 1, {
            ...value[index],
            status: SubscriptionStatus.idle,
          });
        }
      }
      setValue(result);
    }
  }, [socketMessage]);

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
    setTimeout(() => {
      setTableScrollHeight(getTableScroll());
    });
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper subscriptiontab-wrapper"
      title="订阅管理"
      extra={[
        <Search
          placeholder="请输入名称或者关键词"
          style={{ width: 'auto' }}
          enterButton
          allowClear
          loading={loading}
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onSearch={onSearch}
        />,
        <Button key="2" type="primary" onClick={() => addSubscription()}>
          新建订阅
        </Button>,
      ]}
      header={{
        style: headerStyle,
      }}
    >
      <Table
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
