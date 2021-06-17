import React, { PureComponent, Fragment, useState, useEffect } from 'react';
import {
  Button,
  message,
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
  Loading3QuartersOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  EllipsisOutlined,
  PlayCircleOutlined,
  CheckCircleOutlined,
  EditOutlined,
  StopOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  FieldTimeOutlined,
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
  'queued',
}

const CrontabSort: any = { 0: 0, 3: 1, 1: 2, 4: 3 };

enum OperationName {
  '启用',
  '禁用',
  '运行',
  '停止',
}

enum OperationPath {
  'enable',
  'disable',
  'run',
  'stop',
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
          {(!record.isDisabled || record.status !== CrontabStatus.idle) && (
            <>
              {record.status === CrontabStatus.idle && (
                <Tag icon={<ClockCircleOutlined />} color="default">
                  空闲中
                </Tag>
              )}
              {record.status === CrontabStatus.running && (
                <Tag
                  icon={<Loading3QuartersOutlined spin />}
                  color="processing"
                >
                  运行中
                </Tag>
              )}
              {record.status === CrontabStatus.queued && (
                <Tag icon={<FieldTimeOutlined />} color="default">
                  队列中
                </Tag>
              )}
            </>
          )}
          {record.isDisabled === 1 && record.status === CrontabStatus.idle && (
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
          {record.status === CrontabStatus.idle && (
            <Tooltip title="运行">
              <a
                onClick={() => {
                  runCron(record, index);
                }}
              >
                <PlayCircleOutlined />
              </a>
            </Tooltip>
          )}
          {record.status !== CrontabStatus.idle && (
            <Tooltip title="停止">
              <a
                onClick={() => {
                  stopCron(record, index);
                }}
              >
                <PauseCircleOutlined />
              </a>
            </Tooltip>
          )}
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

  const [width, setWidth] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editedCron, setEditedCron] = useState();
  const [searchText, setSearchText] = useState('');
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logCron, setLogCron] = useState<any>();
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const getCrons = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}crons?searchValue=${searchText}`)
      .then((data: any) => {
        setValue(
          data.data.sort((a: any, b: any) => {
            const sortA = a.isDisabled ? 4 : a.status;
            const sortB = b.isDisabled ? 4 : b.status;
            return CrontabSort[sortA] - CrontabSort[sortB];
          }),
        );
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
          .delete(`${config.apiPrefix}crons`, { data: [record._id] })
          .then((data: any) => {
            if (data.code === 200) {
              message.success('删除成功');
              const result = [...value];
              result.splice(index + pageSize * (currentPage - 1), 1);
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
          .put(`${config.apiPrefix}crons/run`, { data: [record._id] })
          .then((data: any) => {
            if (data.code === 200) {
              const result = [...value];
              result.splice(index + pageSize * (currentPage - 1), 1, {
                ...record,
                status: CrontabStatus.running,
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

  const stopCron = (record: any, index: number) => {
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
          .put(`${config.apiPrefix}crons/stop`, { data: [record._id] })
          .then((data: any) => {
            if (data.code === 200) {
              const result = [...value];
              result.splice(index + pageSize * (currentPage - 1), 1, {
                ...record,
                pid: null,
                status: CrontabStatus.idle,
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

  const enabledOrDisabledCron = (record: any, index: number) => {
    Modal.confirm({
      title: `确认${record.isDisabled === 1 ? '启用' : '禁用'}`,
      content: (
        <>
          确认{record.isDisabled === 1 ? '启用' : '禁用'}
          定时任务{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}crons/${
              record.isDisabled === 1 ? 'enable' : 'disable'
            }`,
            {
              data: [record._id],
            },
          )
          .then((data: any) => {
            if (data.code === 200) {
              const newStatus = record.isDisabled === 1 ? 0 : 1;
              const result = [...value];
              result.splice(index + pageSize * (currentPage - 1), 1, {
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
      arrow
      trigger={['click']}
      overlay={
        <Menu onClick={({ key }) => action(key, record, index)}>
          <Menu.Item key="edit" icon={<EditOutlined />}>
            编辑
          </Menu.Item>
          <Menu.Item
            key="enableordisable"
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
        console.log(value);
        const index = value.findIndex((x) => x._id === cron._id);
        console.log(index);
        const result = [...value];
        result.splice(index, 1, {
          ...cron,
          ...data.data,
        });
        setValue(result);
      })
      .finally(() => setLoading(false));
  };

  const onSelectChange = (selectedIds: any[]) => {
    setSelectedRowIds(selectedIds);
  };

  const rowSelection = {
    selectedRowIds,
    onChange: onSelectChange,
    selections: [
      Table.SELECTION_ALL,
      Table.SELECTION_INVERT,
      Table.SELECTION_NONE,
    ],
  };

  const delCrons = () => {
    Modal.confirm({
      title: '确认删除',
      content: <>确认删除选中的定时任务吗</>,
      onOk() {
        request
          .delete(`${config.apiPrefix}crons`, { data: selectedRowIds })
          .then((data: any) => {
            if (data.code === 200) {
              message.success('批量删除成功');
              setSelectedRowIds([]);
              getCrons();
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

  const operateCrons = (operationStatus: number) => {
    Modal.confirm({
      title: `确认${OperationName[operationStatus]}`,
      content: <>确认{OperationName[operationStatus]}选中的定时任务吗</>,
      onOk() {
        request
          .put(`${config.apiPrefix}crons/${OperationPath[operationStatus]}`, {
            data: selectedRowIds,
          })
          .then((data: any) => {
            if (data.code === 200) {
              getCrons();
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

  const onPageChange = (page: number, pageSize: number | undefined) => {
    setCurrentPage(page);
    setPageSize(pageSize as number);
    localStorage.setItem('pageSize', pageSize + '');
  };

  useEffect(() => {
    if (logCron) {
      localStorage.setItem('logCron', logCron._id);
      setIsLogModalVisible(true);
    }
  }, [logCron]);

  useEffect(() => {
    getCrons();
  }, [searchText]);

  useEffect(() => {
    if (document.body.clientWidth < 768) {
      setWidth('auto');
      setMarginLeft(0);
      setMarginTop(0);
    } else {
      setWidth('100%');
      setMarginLeft(0);
      setMarginTop(-72);
    }
    setPageSize(parseInt(localStorage.getItem('pageSize') || '20'));
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper crontab-wrapper"
      title="定时任务"
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
    >
      {selectedRowIds.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Button type="primary" style={{ marginBottom: 5 }} onClick={delCrons}>
            批量删除
          </Button>
          <Button
            type="primary"
            onClick={() => operateCrons(0)}
            style={{ marginLeft: 8, marginBottom: 5 }}
          >
            批量启用
          </Button>
          <Button
            type="primary"
            onClick={() => operateCrons(1)}
            style={{ marginLeft: 8, marginRight: 8 }}
          >
            批量禁用
          </Button>
          <Button
            type="primary"
            style={{ marginRight: 8 }}
            onClick={() => operateCrons(2)}
          >
            批量运行
          </Button>
          <Button type="primary" onClick={() => operateCrons(3)}>
            批量停止
          </Button>
          <span style={{ marginLeft: 8 }}>
            已选择
            <a>{selectedRowIds?.length}</a>项
          </span>
        </div>
      )}
      <Table
        columns={columns}
        pagination={{
          hideOnSinglePage: true,
          current: currentPage,
          onChange: onPageChange,
          pageSize: pageSize,
          showSizeChanger: true,
          defaultPageSize: 20,
          showTotal: (total: number, range: number[]) =>
            `第 ${range[0]}-${range[1]} 条/总共 ${total} 条`,
        }}
        dataSource={value}
        rowKey="_id"
        size="middle"
        scroll={{ x: 768 }}
        loading={loading}
        rowSelection={rowSelection}
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
