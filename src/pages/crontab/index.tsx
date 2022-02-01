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
  Popover,
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
  PushpinOutlined,
} from '@ant-design/icons';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import CronModal, { CronLabelModal } from './modal';
import CronLogModal from './logModal';
import cron_parser from 'cron-parser';
import { diffTime } from '@/utils/date';
import { getTableScroll } from '@/utils/index';
import { history } from 'umi';
import './index.less';

const { Text } = Typography;
const { Search } = Input;

enum CrontabStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}

const CrontabSort: any = { 0: 0, 5: 1, 3: 2, 1: 3, 4: 4 };

enum OperationName {
  '启用',
  '禁用',
  '运行',
  '停止',
  '置顶',
  '取消置顶',
}

enum OperationPath {
  'enable',
  'disable',
  'run',
  'stop',
  'pin',
  'unpin',
}

const Crontab = ({ headerStyle, isPhone }: any) => {
  const columns: any = [
    {
      title: '任务名',
      dataIndex: 'name',
      key: 'name',
      width: 150,
      align: 'center' as const,
      render: (text: string, record: any) => (
        <>
          <a
            onClick={() => {
              goToScriptManager(record);
            }}
          >
            {record.name || record._id}{' '}
            {record.isPinned ? (
              <span>
                <PushpinOutlined />
              </span>
            ) : (
              ''
            )}
          </a>
          <span>
            {record.labels?.length > 0 && record.labels[0] !== '' ? (
              <Popover
                placement="right"
                trigger={isPhone ? 'click' : 'hover'}
                content={
                  <div>
                    {record.labels?.map((label: string, i: number) => (
                      <Tag
                        color="blue"
                        onClick={() => {
                          onSearch(`label:${label}`);
                        }}
                      >
                        {label}
                      </Tag>
                    ))}
                  </div>
                }
              >
                <Tag color="blue">{record.labels[0]}</Tag>
              </Popover>
            ) : (
              ''
            )}
          </span>
        </>
      ),
      sorter: {
        compare: (a: any, b: any) => a.name.localeCompare(b.name),
        multiple: 2,
      },
    },
    {
      title: '任务',
      dataIndex: 'command',
      key: 'command',
      width: 250,
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
      sorter: {
        compare: (a: any, b: any) => a.command.localeCompare(b.command),
        multiple: 3,
      },
    },
    {
      title: '任务定时',
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
      title: '最后运行时间',
      align: 'center' as const,
      width: 150,
      sorter: {
        compare: (a: any, b: any) => {
          return a.last_execution_time - b.last_execution_time;
        },
      },
      render: (text: string, record: any) => {
        const language = navigator.language || navigator.languages[0];
        return (
          <span
            style={{
              display: 'block',
            }}
          >
            {record.last_execution_time
              ? new Date(record.last_execution_time * 1000)
                  .toLocaleString(language, {
                    hour12: false,
                  })
                  .replace(' 24:', ' 00:')
              : '-'}
          </span>
        );
      },
    },
    {
      title: '最后运行时长',
      align: 'center' as const,
      width: 120,
      sorter: {
        compare: (a: any, b: any) => {
          return a.last_running_time - b.last_running_time;
        },
      },
      render: (text: string, record: any) => {
        const language = navigator.language || navigator.languages[0];
        return (
          <span
            style={{
              display: 'block',
            }}
          >
            {record.last_running_time
              ? diffTime(record.last_running_time)
              : '-'}
          </span>
        );
      },
    },
    {
      title: '下次运行时间',
      align: 'center' as const,
      width: 150,
      sorter: {
        compare: (a: any, b: any) => {
          return a.nextRunTime - b.nextRunTime;
        },
      },
      render: (text: string, record: any) => {
        const language = navigator.language || navigator.languages[0];
        return (
          <span
            style={{
              display: 'block',
            }}
          >
            {record.nextRunTime
              .toLocaleString(language, {
                hour12: false,
              })
              .replace(' 24:', ' 00:')}
          </span>
        );
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
        {
          text: '队列中',
          value: 3,
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
      width: 100,
      render: (text: string, record: any, index: number) => {
        const isPc = !isPhone;
        return (
          <Space size="middle">
            {record.status === CrontabStatus.idle && (
              <Tooltip title={isPc ? '运行' : ''}>
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
              <Tooltip title={isPc ? '停止' : ''}>
                <a
                  onClick={() => {
                    stopCron(record, index);
                  }}
                >
                  <PauseCircleOutlined />
                </a>
              </Tooltip>
            )}
            <Tooltip title={isPc ? '日志' : ''}>
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
        );
      },
    },
  ];

  const [value, setValue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isLabelModalVisible, setisLabelModalVisible] = useState(false);
  const [editedCron, setEditedCron] = useState();
  const [searchText, setSearchText] = useState('');
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logCron, setLogCron] = useState<any>();
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [tableScrollHeight, setTableScrollHeight] = useState<number>();

  const goToScriptManager = (record: any) => {
    const cmd = record.command.split(' ') as string[];
    if (cmd[0] === 'task') {
      if (cmd[1].startsWith('/ql/scripts')) {
        cmd[1] = cmd[1].replace('/ql/scripts/', '');
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

  const getCrons = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}crons?searchValue=${searchText}`)
      .then((data: any) => {
        setValue(
          data.data
            .sort((a: any, b: any) => {
              const sortA =
                a.isPinned && a.status !== 0
                  ? 5
                  : a.isDisabled && a.status !== 0
                  ? 4
                  : a.status;
              const sortB =
                b.isPinned && b.status !== 0
                  ? 5
                  : b.isDisabled && b.status !== 0
                  ? 4
                  : b.status;
              return CrontabSort[sortA] - CrontabSort[sortB];
            })
            .map((x) => {
              return {
                ...x,
                nextRunTime: cron_parser
                  .parseExpression(x.schedule)
                  .next()
                  .toDate(),
              };
            }),
        );
        setCurrentPage(1);
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
          .delete(`${config.apiPrefix}crons`, { data: [record.id] })
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
          .put(`${config.apiPrefix}crons/run`, { data: [record.id] })
          .then((data: any) => {
            if (data.code === 200) {
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              result.splice(i, 1, {
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
          .put(`${config.apiPrefix}crons/stop`, { data: [record.id] })
          .then((data: any) => {
            if (data.code === 200) {
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              result.splice(i, 1, {
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

  const pinOrUnPinCron = (record: any, index: number) => {
    Modal.confirm({
      title: `确认${record.isPinned === 1 ? '取消置顶' : '置顶'}`,
      content: (
        <>
          确认{record.isPinned === 1 ? '取消置顶' : '置顶'}
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
              record.isPinned === 1 ? 'unpin' : 'pin'
            }`,
            {
              data: [record.id],
            },
          )
          .then((data: any) => {
            if (data.code === 200) {
              const newStatus = record.isPinned === 1 ? 0 : 1;
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              result.splice(i, 1, {
                ...record,
                isPinned: newStatus,
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
          <Menu.Item
            key="pinOrUnPin"
            icon={
              record.isPinned === 1 ? <StopOutlined /> : <PushpinOutlined />
            }
          >
            {record.isPinned === 1 ? '取消置顶' : '置顶'}
          </Menu.Item>
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
      case 'enableOrDisable':
        enabledOrDisabledCron(record, index);
        break;
      case 'delete':
        delCron(record, index);
        break;
      case 'pinOrUnPin':
        pinOrUnPinCron(record, index);
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
    setSearchText(value.trim());
  };

  const handleCrons = (cron: any) => {
    const index = value.findIndex((x) => x.id === cron.id);
    const result = [...value];
    cron.nextRunTime = cron_parser
      .parseExpression(cron.schedule)
      .next()
      .toDate();
    if (index === -1) {
      result.unshift(cron);
    } else {
      result.splice(index, 1, {
        ...cron,
      });
    }
    setValue(result);
  };

  const getCronDetail = (cron: any) => {
    request
      .get(`${config.apiPrefix}crons/${cron.id}`)
      .then((data: any) => {
        const index = value.findIndex((x) => x.id === cron.id);
        const result = [...value];
        data.data.nextRunTime = cron_parser
          .parseExpression(data.data.schedule)
          .next()
          .toDate();
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

    setTimeout(() => {
      if (selectedRowIds.length === 0 || selectedIds.length === 0) {
        setTableScrollHeight(getTableScroll());
      }
    });
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

  const getRowClassName = (record: any, index: number) => {
    return record.isPinned ? 'pinned-cron' : '';
  };

  useEffect(() => {
    if (logCron) {
      localStorage.setItem('logCron', logCron.id);
      setIsLogModalVisible(true);
    }
  }, [logCron]);

  useEffect(() => {
    getCrons();
  }, [searchText]);

  useEffect(() => {
    setPageSize(parseInt(localStorage.getItem('pageSize') || '20'));
    setTimeout(() => {
      setTableScrollHeight(getTableScroll());
    });
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
          新建任务
        </Button>,
      ]}
      header={{
        style: headerStyle,
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
          <Button
            type="primary"
            onClick={() => operateCrons(4)}
            style={{ marginLeft: 8, marginRight: 8 }}
          >
            批量置顶
          </Button>
          <Button
            type="primary"
            onClick={() => operateCrons(5)}
            style={{ marginLeft: 8, marginRight: 8 }}
          >
            批量取消置顶
          </Button>
          <Button
            type="primary"
            onClick={() => setisLabelModalVisible(true)}
            style={{ marginLeft: 8, marginRight: 8 }}
          >
            批量修改标签
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
          current: currentPage,
          onChange: onPageChange,
          pageSize: pageSize,
          showSizeChanger: true,
          simple: isPhone,
          defaultPageSize: 20,
          showTotal: (total: number, range: number[]) =>
            `第 ${range[0]}-${range[1]} 条/总共 ${total} 条`,
          pageSizeOptions: [10, 20, 50, 100, 200, 500, 1000],
        }}
        dataSource={value}
        rowKey="id"
        size="middle"
        scroll={{ x: 1000, y: tableScrollHeight }}
        loading={loading}
        rowSelection={rowSelection}
        rowClassName={getRowClassName}
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
      <CronLabelModal
        visible={isLabelModalVisible}
        handleCancel={(needUpdate?: boolean) => {
          setisLabelModalVisible(false);
          if (needUpdate) {
            getCrons();
          }
        }}
        ids={selectedRowIds}
      />
    </PageContainer>
  );
};

export default Crontab;
