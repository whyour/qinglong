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
} from '@ant-design/icons';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import SubscriptionModal from './modal';
import { getTableScroll } from '@/utils/index';
import { history } from 'umi';
import './index.less';

const { Text, Paragraph } = Typography;
const { Search } = Input;

export enum SubscriptionStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}

const Subscription = ({ headerStyle, isPhone, theme }: any) => {
  const columns: any = [
    {
      title: '订阅名',
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
      title: '订阅',
      dataIndex: 'command',
      key: 'command',
      width: 250,
      align: 'center' as const,
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
      sorter: {
        compare: (a: any, b: any) => a.command.localeCompare(b.command),
        multiple: 3,
      },
    },
    {
      title: '订阅定时',
      dataIndex: 'schedule',
      key: 'schedule',
      width: 110,
      align: 'center' as const,
      sorter: {
        compare: (a: any, b: any) => a.schedule.localeCompare(b.schedule),
        multiple: 1,
      },
    },
    {
      title: '状态',
      key: 'status',
      dataIndex: 'status',
      align: 'center' as const,
      width: 85,
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
        if (record.isDisabled && record.status !== 0) {
          return value === 2;
        } else {
          return record.status === value;
        }
      },
      render: (text: string, record: any) => (
        <>
          {(!record.isDisabled ||
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
          {record.isDisabled === 1 &&
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
      width: 100,
      render: (text: string, record: any, index: number) => {
        return (
          <Space size="middle">
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

  const goToScriptManager = (record: any) => {
    const cmd = record.command.split(' ') as string[];
    if (cmd[0] === 'task') {
      if (cmd[1].startsWith('/ql/data/scripts')) {
        cmd[1] = cmd[1].replace('/ql/data/scripts/', '');
      }

      let [p, s] = cmd[1].split('/');
      if (!s) {
        s = p;
        p = '';
      }
      history.push(`/script?p=${p}&s=${s}`);
    } else if (cmd[1] === 'repo') {
      location.href = cmd[2];
    }
  };

  const getSubscriptions = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}subscriptions?searchValue=${searchText}`)
      .then((data: any) => {
        setValue(data.data);
        setCurrentPage(1);
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
          .then((data: any) => {
            if (data.code === 200) {
              message.success('删除成功');
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              result.splice(i, 1);
              setValue(result);
            } else {
              message.error(data);
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
      title: `确认${record.isDisabled === 1 ? '启用' : '禁用'}`,
      content: (
        <>
          确认{record.isDisabled === 1 ? '启用' : '禁用'}
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
              record.isDisabled === 1 ? 'enable' : 'disable'
            }`,
            {
              data: [record.id],
            },
          )
          .then((data: any) => {
            if (data.code === 200) {
              const newStatus = record.isDisabled === 1 ? 0 : 1;
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              result.splice(i, 1, {
                ...record,
                isDisabled: newStatus,
              });
              setValue(result);
            } else {
              message.error(data);
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
          onClick={({ key, domEvent }) => {
            domEvent.stopPropagation();
            action(key, record, index);
          }}
        >
          <Menu.Item key="edit" icon={<EditOutlined />}>
            编辑
          </Menu.Item>
          <Menu.Item
            key="enableOrDisable"
            icon={
              record.isDisabled === 1 ? (
                <CheckCircleOutlined />
              ) : (
                <StopOutlined />
              )
            }
          >
            {record.isDisabled === 1 ? '启用' : '禁用'}
          </Menu.Item>
          <Menu.Item key="delete" icon={<DeleteOutlined />}>
            删除
          </Menu.Item>
        </Menu>
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
    </PageContainer>
  );
};

export default Subscription;
