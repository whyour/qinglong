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

const { Text } = Typography;

enum CrontabStatus {
  'idle',
  'running',
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
      align: 'center' as const,
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
                runCron(record);
              }}
            >
              <PlayCircleOutlined />
            </a>
          </Tooltip>
          <Tooltip title="日志">
            <a
              onClick={() => {
                logCron(record);
              }}
            >
              <FileTextOutlined />
            </a>
          </Tooltip>
          <MoreBtn key="more" record={record} />
        </Space>
      ),
    },
  ];

  const [width, setWdith] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState();
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editedCron, setEditedCron] = useState();

  const getCrons = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}crons`)
      .then((data: any) => {
        setValue(data.data.sort((a: any, b: any) => a.status - b.status));
      })
      .finally(() => setLoading(false));
  };

  const addCron = () => {
    setIsModalVisible(true);
  };

  const editCron = (record: any) => {
    setEditedCron(record);
    setIsModalVisible(true);
  };

  const delCron = (record: any) => {
    Modal.confirm({
      title: '确认删除',
      content: (
        <>
          确认删除定时任务 <Text type="warning">{record.name}</Text> 吗
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}crons`, {
            data: { _id: record._id },
          })
          .then((data: any) => {
            if (data.code === 200) {
              notification.success({
                message: '删除成功',
              });
              getCrons();
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

  const runCron = (record: any) => {
    Modal.confirm({
      title: '确认运行',
      content: (
        <>
          确认运行定时任务 <Text type="warning">{record.name}</Text> 吗
        </>
      ),
      onOk() {
        request
          .get(`${config.apiPrefix}crons/${record._id}/run`)
          .then((data: any) => {
            getCrons();
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const enabledOrDisabledCron = (record: any) => {
    Modal.confirm({
      title: '确认禁用',
      content: (
        <>
          确认禁用定时任务 <Text type="warning">{record.name}</Text> 吗
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
                message: '禁用成功',
              });
              getCrons();
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

  const logCron = (record: any) => {
    request
      .get(`${config.apiPrefix}crons/${record._id}/log`)
      .then((data: any) => {
        Modal.info({
          width: 650,
          title: `${record.name || record._id}`,
          content: (
            <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
              {data.data || '暂无日志'}
            </pre>
          ),
          onOk() {},
        });
      });
  };

  const MoreBtn: React.FC<{
    record: any;
  }> = ({ record }) => (
    <Dropdown
      arrow
      trigger={['click', 'hover']}
      overlay={
        <Menu onClick={({ key }) => action(key, record)}>
          <Menu.Item key="edit" icon={<EditOutlined />}>
            编辑
          </Menu.Item>
          {record.isSystem === 0 && (
            <>
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
              <Menu.Item key="delete" icon={<DeleteOutlined />}>
                删除
              </Menu.Item>
            </>
          )}
        </Menu>
      }
    >
      <a>
        <EllipsisOutlined />
      </a>
    </Dropdown>
  );

  const action = (key: string | number, record: any) => {
    switch (key) {
      case 'edit':
        editCron(record);
        break;
      case 'enableordisable':
        enabledOrDisabledCron(record);
        break;
      case 'delete':
        delCron(record);
        break;
      default:
        break;
    }
  };

  const handleCancel = (needUpdate?: boolean) => {
    setIsModalVisible(false);
    if (needUpdate) {
      getCrons();
    }
  };

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
    getCrons();
  }, []);

  return (
    <PageContainer
      className="code-mirror-wrapper"
      title="定时任务"
      loading={loading}
      extra={[
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
    >
      <Table
        columns={columns}
        pagination={{
          hideOnSinglePage: true,
          showSizeChanger: true,
          defaultPageSize: 20,
        }}
        dataSource={value}
        rowKey="pin"
        size="middle"
        bordered
        scroll={{ x: 768 }}
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
