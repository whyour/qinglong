import React, { PureComponent, Fragment, useState, useEffect } from 'react';
import {
  Button,
  notification,
  Modal,
  Table,
  Tag,
  Space,
  Tooltip,
  Dropdown,
  Menu,
  Typography,
  Input,
} from 'antd';
import {
  ClockCircleOutlined,
  SyncOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  EllipsisOutlined,
  PlayCircleOutlined,
  CheckCircleOutlined,
  EditOutlined,
  StopOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import CronModal from './modal';
import CronLogModal from './logModal';

const { Text } = Typography;
const { Search } = Input;

enum CrontabStatus {
  'running',
  'idle',
  'disabled',
}

const Crontab = () => {
  const columns = [
    {
      title: '任务名',
      dataIndex: 'name',
      key: 'name',
      align: 'center' as const,
      render: (text: string, record: any) => (
        <span>{record.name || record._id}</span>
      ),
    },
    {
      title: '任务',
      dataIndex: 'command',
      key: 'command',
      width: '40%',
      align: 'center' as const,
      render: (text: string, record: any) => {
        return (
          <span
            style={{
              textAlign: 'left',
              width: '100%',
              display: 'inline-block',
              wordBreak: 'break-all',
            }}
          >
            {text}
          </span>
        );
      },
    },
    {
      title: '任务定时',
      dataIndex: 'schedule',
      key: 'schedule',
      align: 'center' as const,
    },
    {
      title: '状态',
      key: 'status',
      dataIndex: 'status',
      align: 'center' as const,
      render: (text: string, record: any) => (
        <>
          {record.status === CrontabStatus.idle && (
            <Tag icon={<ClockCircleOutlined />} color="default">
              空闲中
            </Tag>
          )}
          {record.status === CrontabStatus.running && (
            <Tag icon={<SyncOutlined spin />} color="processing">
              运行中
            </Tag>
          )}
          {record.status === CrontabStatus.disabled && (
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
      render: (text: string, record: any, index: number) => (
        <Space size="middle">
          <Tooltip title="运行">
            <a
              onClick={() => {
                runCron(record, index);
              }}
            >
              <PlayCircleOutlined />
            </a>
          </Tooltip>
          <Tooltip title="日志">
            <a
              onClick={() => {
                setLogCron({ ...record, timestamp: Date.now() });
              }}
            >
              <FileTextOutlined />
            </a>
          </Tooltip>
          <MoreBtn key="more" record={record} index={index} />
        </Space>
      ),
    },
  ];

  const [width, setWdith] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editedCron, setEditedCron] = useState();
  const [searchText, setSearchText] = useState('');
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logCron, setLogCron] = useState<any>();

  const getCrons = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}crons?searchValue=${searchText}`)
      .then((data: any) => {
        setValue(data.data.sort((a: any, b: any) => a.status - b.status));
      })
      .finally(() => setLoading(false));
  };

  const addCron = () => {
    setEditedCron(null as any);
    setIsModalVisible(true);
  };

  const editCron = (record: any, index: number) => {
    setEditedCron(record);
    setIsModalVisible(true);
  };

  const delCron = (record: any, index: number) => {
    Modal.confirm({
      title: '确认删除',
      content: (
        <>
          确认删除定时任务{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}crons/${record._id}`)
          .then((data: any) => {
            if (data.code === 200) {
              notification.success({
                message: '删除成功',
              });
              const result = [...value];
              result.splice(index, 1);
              setValue(result);
            } else {
              notification.error({
                message: data,
              });
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const runCron = (record: any, index: number) => {
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
          .get(`${config.apiPrefix}crons/${record._id}/run`)
          .then((data: any) => {
            if (data.code === 200) {
              const result = [...value];
              result.splice(index, 1, {
                ...record,
                status: CrontabStatus.running,
              });
              setValue(result);
            } else {
              notification.error({
                message: data,
              });
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const enabledOrDisabledCron = (record: any, index: number) => {
    Modal.confirm({
      title: `确认${
        record.status === CrontabStatus.disabled ? '启用' : '禁用'
      }`,
      content: (
        <>
          确认{record.status === CrontabStatus.disabled ? '启用' : '禁用'}
          定时任务{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .get(
            `${config.apiPrefix}crons/${record._id}/${
              record.status === CrontabStatus.disabled ? 'enable' : 'disable'
            }`,
            {
              data: { _id: record._id },
            },
          )
          .then((data: any) => {
            if (data.code === 200) {
              notification.success({
                message: `${
                  record.status === CrontabStatus.disabled ? '启用' : '禁用'
                }成功`,
              });
              const newStatus =
                record.status === CrontabStatus.disabled
                  ? CrontabStatus.idle
                  : CrontabStatus.disabled;
              const result = [...value];
              result.splice(index, 1, {
                ...record,
                status: newStatus,
              });
              setValue(result);
            } else {
              notification.error({
                message: data,
              });
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
      arrow
      trigger={['click', 'hover']}
      overlay={
        <Menu onClick={({ key }) => action(key, record, index)}>
          <Menu.Item key="edit" icon={<EditOutlined />}>
            编辑
          </Menu.Item>
          <Menu.Item
            key="enableordisable"
            icon={
              record.status === CrontabStatus.disabled ? (
                <CheckCircleOutlined />
              ) : (
                <StopOutlined />
              )
            }
          >
            {record.status === CrontabStatus.disabled ? '启用' : '禁用'}
          </Menu.Item>
          {record.isSystem !== 1 && (
            <Menu.Item key="delete" icon={<DeleteOutlined />}>
              删除
            </Menu.Item>
          )}
        </Menu>
      }
    >
      <a>
        <EllipsisOutlined />
      </a>
    </Dropdown>
  );

  const action = (key: string | number, record: any, index: number) => {
    switch (key) {
      case 'edit':
        editCron(record, index);
        break;
      case 'enableordisable':
        enabledOrDisabledCron(record, index);
        break;
      case 'delete':
        delCron(record, index);
        break;
      default:
        break;
    }
  };

  const handleCancel = (cron?: any) => {
    setIsModalVisible(false);
    if (cron) {
      handleCrons(cron);
    }
  };

  const onSearch = (value: string) => {
    setSearchText(value);
  };

  const handleCrons = (cron: any) => {
    const index = value.findIndex((x) => x._id === cron._id);
    const result = [...value];
    if (index === -1) {
      result.push(cron);
    } else {
      result.splice(index, 1, {
        ...cron,
      });
    }
    setValue(result);
  };

  const getCronDetail = (cron: any) => {
    request
      .get(`${config.apiPrefix}crons/${cron._id}`)
      .then((data: any) => {
        const index = value.findIndex((x) => x._id === cron._id);
        const result = [...value];
        result.splice(index, 1, {
          ...cron,
          ...data.data,
        });
        setValue(result);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (logCron) {
      setIsLogModalVisible(true);
    }
  }, [logCron]);

  useEffect(() => {
    getCrons();
  }, [searchText]);

  useEffect(() => {
    if (document.body.clientWidth < 768) {
      setWdith('auto');
      setMarginLeft(0);
      setMarginTop(0);
    } else {
      setWdith('100%');
      setMarginLeft(0);
      setMarginTop(-72);
    }
  }, []);

  return (
    <PageContainer
      className="code-mirror-wrapper"
      title="定时任务"
      loading={loading}
      extra={[
        <Search
          placeholder="请输入名称或者关键词"
          style={{ width: 'auto' }}
          enterButton
          loading={loading}
          onSearch={onSearch}
        />,
        <Button key="2" type="primary" onClick={() => addCron()}>
          添加定时
        </Button>,
      ]}
      header={{
        style: {
          padding: '4px 16px 4px 15px',
          position: 'sticky',
          top: 0,
          left: 0,
          zIndex: 20,
          marginTop,
          width,
          marginLeft,
        },
      }}
      style={{
        height: '100vh',
      }}
    >
      <Table
        columns={columns}
        pagination={{
          hideOnSinglePage: true,
          showSizeChanger: true,
          defaultPageSize: 20,
        }}
        dataSource={value}
        rowKey="_id"
        size="middle"
        bordered
        scroll={{ x: 768 }}
      />
      <CronLogModal
        visible={isLogModalVisible}
        handleCancel={() => {
          getCronDetail(logCron);
          setIsLogModalVisible(false);
        }}
        cron={logCron}
      />
      <CronModal
        visible={isModalVisible}
        handleCancel={handleCancel}
        cron={editedCron}
      />
    </PageContainer>
  );
};

export default Crontab;
