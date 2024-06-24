import intl from 'react-intl-universal';
import React, { useState, useEffect, useRef, useMemo } from 'react';
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
  Tabs,
  TablePaginationConfig,
  MenuProps,
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
  DownOutlined,
  SettingOutlined,
  PlusOutlined,
  UnorderedListOutlined,
  CheckOutlined,
} from '@ant-design/icons';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import CronModal, { CronLabelModal } from './modal';
import CronLogModal from './logModal';
import CronDetailModal from './detail';
import { diffTime } from '@/utils/date';
import { history, useOutletContext } from '@umijs/max';
import './index.less';
import ViewCreateModal from './viewCreateModal';
import ViewManageModal from './viewManageModal';
import { FilterValue, SorterResult } from 'antd/lib/table/interface';
import { SharedContext } from '@/layouts';
import useTableScrollHeight from '@/hooks/useTableScrollHeight';
import { getCommandScript, getCrontabsNextDate, parseCrontab } from '@/utils';
import { ColumnProps } from 'antd/lib/table';
import { useVT } from 'virtualizedtableforantd4';
import { ICrontab, OperationName, OperationPath, CrontabStatus } from './type';
import Name from '@/components/name';
import dayjs from 'dayjs';
import { noop } from 'lodash';

const { Text, Paragraph, Link } = Typography;
const { Search } = Input;

const Crontab = () => {
  const { headerStyle, isPhone, theme } = useOutletContext<SharedContext>();
  const columns: ColumnProps<ICrontab>[] = [
    {
      title: intl.get('名称'),
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 120,
      render: (text: string, record: any) => (
        <Paragraph
          style={{
            wordBreak: 'break-all',
            marginBottom: 0,
            color: '#1890ff',
            cursor: 'pointer',
          }}
          ellipsis={{ tooltip: text, rows: 2 }}
          onClick={() => {
            setDetailCron(record);
            setIsDetailModalVisible(true);
          }}
        >
          <Link>{record.name || '-'}</Link>
        </Paragraph>
      ),
      sorter: {
        compare: (a, b) => a?.name?.localeCompare(b?.name),
      },
    },
    {
      title: intl.get('命令/脚本'),
      dataIndex: 'command',
      key: 'command',
      width: 240,
      render: (text, record) => {
        return (
          <Paragraph
            style={{
              wordBreak: 'break-all',
              marginBottom: 0,
            }}
            ellipsis={{ tooltip: text, rows: 2 }}
          >
            <a
              onClick={() => {
                goToScriptManager(record);
              }}
            >
              {text}
            </a>
          </Paragraph>
        );
      },
      sorter: {
        compare: (a: any, b: any) => a.command.localeCompare(b.command),
      },
    },
    {
      title: intl.get('状态'),
      key: 'status',
      dataIndex: 'status',
      width: 100,
      filters: [
        {
          text: intl.get('运行中'),
          value: CrontabStatus.running,
        },
        {
          text: intl.get('空闲中'),
          value: CrontabStatus.idle,
        },
        {
          text: intl.get('已禁用'),
          value: CrontabStatus.disabled,
        },
        {
          text: intl.get('队列中'),
          value: CrontabStatus.queued,
        },
      ],
      render: (text, record) => (
        <>
          {(!record.isDisabled || record.status !== CrontabStatus.idle) && (
            <>
              {record.status === CrontabStatus.idle && (
                <Tag icon={<ClockCircleOutlined />} color="default">
                  {intl.get('空闲中')}
                </Tag>
              )}
              {record.status === CrontabStatus.running && (
                <Tag
                  icon={<Loading3QuartersOutlined spin />}
                  color="processing"
                >
                  {intl.get('运行中')}
                </Tag>
              )}
              {record.status === CrontabStatus.queued && (
                <Tag icon={<FieldTimeOutlined />} color="default">
                  {intl.get('队列中')}
                </Tag>
              )}
            </>
          )}
          {record.isDisabled === 1 && record.status === CrontabStatus.idle && (
            <Tag icon={<CloseCircleOutlined />} color="error">
              {intl.get('已禁用')}
            </Tag>
          )}
        </>
      ),
    },
    {
      title: intl.get('定时规则'),
      dataIndex: 'schedule',
      key: 'schedule',
      width: 150,
      sorter: {
        compare: (a, b) => a.schedule.localeCompare(b.schedule),
      },
      render: (text, record) => {
        return (
          <Paragraph
            style={{
              wordBreak: 'break-all',
              marginBottom: 0,
            }}
            ellipsis={{
              tooltip: {
                placement: 'right',
                title: (
                  <>
                    <div>{text}</div>
                    {record.extra_schedules?.map((x) => (
                      <div key={x.schedule}>{x.schedule}</div>
                    ))}
                  </>
                ),
              },
              rows: 2,
            }}
          >
            {text}
          </Paragraph>
        );
      },
    },
    {
      title: intl.get('最后运行时长'),
      width: 167,
      dataIndex: 'last_running_time',
      key: 'last_running_time',
      sorter: {
        compare: (a: any, b: any) => {
          return a.last_running_time - b.last_running_time;
        },
      },
      render: (text, record) => {
        return record.last_running_time
          ? diffTime(record.last_running_time)
          : '-';
      },
    },
    {
      title: intl.get('最后运行时间'),
      dataIndex: 'last_execution_time',
      key: 'last_execution_time',
      width: 141,
      sorter: {
        compare: (a, b) => {
          return (a.last_execution_time || 0) - (b.last_execution_time || 0);
        },
      },
      render: (text, record) => {
        return (
          <span
            style={{
              display: 'block',
            }}
          >
            {record.last_execution_time
              ? dayjs(record.last_execution_time * 1000).format(
                  'YYYY-MM-DD HH:mm:ss',
                )
              : '-'}
          </span>
        );
      },
    },
    {
      title: intl.get('下次运行时间'),
      width: 144,
      sorter: {
        compare: (a: any, b: any) => {
          return a.nextRunTime - b.nextRunTime;
        },
      },
      render: (text, record) => {
        return dayjs(record.nextRunTime).format('YYYY-MM-DD HH:mm:ss');
      },
    },
    {
      title: intl.get('关联订阅'),
      width: 185,
      render: (text, record: any) =>
        record.sub_id ? (
          <Name
            service={() =>
              request.get(`${config.apiPrefix}subscriptions/${record.sub_id}`, {
                onError: noop,
              })
            }
            options={{
              ready: record?.sub_id,
              cacheKey: record.sub_id,
            }}
          />
        ) : (
          '-'
        ),
    },
    {
      title: intl.get('操作'),
      key: 'action',
      width: 140,
      fixed: isPhone ? undefined : 'right',
      render: (text, record, index) => {
        const isPc = !isPhone;
        return (
          <Space size="middle">
            {record.status === CrontabStatus.idle && (
              <a
                onClick={(e) => {
                  e.stopPropagation();
                  runCron(record, index);
                }}
              >
                {intl.get('运行')}
              </a>
            )}
            {record.status !== CrontabStatus.idle && (
              <a
                onClick={(e) => {
                  e.stopPropagation();
                  stopCron(record, index);
                }}
              >
                {intl.get('停止')}
              </a>
            )}
            <a
              onClick={(e) => {
                e.stopPropagation();
                setLogCron({ ...record, timestamp: Date.now() });
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
  const [isLabelModalVisible, setIsLabelModalVisible] = useState(false);
  const [editedCron, setEditedCron] = useState();
  const [searchText, setSearchText] = useState('');
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logCron, setLogCron] = useState<any>();
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [pageConf, setPageConf] = useState<{
    page: number;
    size: number;
    sorter: any;
    filters: any;
  }>({} as any);
  const [viewConf, setViewConf] = useState<any>();
  const [isDetailModalVisible, setIsDetailModalVisible] = useState(false);
  const [detailCron, setDetailCron] = useState<any>();
  const [searchValue, setSearchValue] = useState('');
  const [total, setTotal] = useState<number>();
  const [isCreateViewModalVisible, setIsCreateViewModalVisible] =
    useState(false);
  const [isViewManageModalVisible, setIsViewManageModalVisible] =
    useState(false);
  const [cronViews, setCronViews] = useState<any[]>([]);
  const [enabledCronViews, setEnabledCronViews] = useState<any[]>([]);
  const [moreMenuActive, setMoreMenuActive] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const tableScrollHeight = useTableScrollHeight(tableRef);
  const [activeKey, setActiveKey] = useState('');

  const goToScriptManager = (record: any) => {
    const result = getCommandScript(record.command);
    if (Array.isArray(result)) {
      const [s, p] = result;
      history.push(`/script?p=${p}&s=${s}`);
    } else if (result) {
      location.href = result;
    }
  };

  const getCrons = () => {
    setLoading(true);
    const { page, size, sorter, filters } = pageConf;
    let url = `${
      config.apiPrefix
    }crons?searchValue=${searchText}&page=${page}&size=${size}&filters=${JSON.stringify(
      filters,
    )}`;
    if (sorter && sorter.column && sorter.order) {
      url += `&sorter=${JSON.stringify({
        field: sorter.column.key,
        type: sorter.order === 'ascend' ? 'ASC' : 'DESC',
      })}`;
    }
    if (viewConf) {
      url += `&queryString=${JSON.stringify({
        filters: viewConf.filters,
        sorts: viewConf.sorts,
        filterRelation: viewConf.filterRelation || 'and',
      })}`;
    }
    request
      .get(url)
      .then(({ code, data: _data }) => {
        if (code === 200) {
          const { data, total } = _data;
          setValue(
            data.map((x) => {
              return {
                ...x,
                nextRunTime: getCrontabsNextDate(x.schedule, x.extra_schedules),
              };
            }),
          );
          setTotal(total);
        }
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
      title: intl.get('确认删除'),
      content: (
        <>
          {intl.get('确认删除定时任务')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}crons`, { data: [record.id] })
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

  const runCron = (record: any, index: number) => {
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
          .put(`${config.apiPrefix}crons/run`, [record.id])
          .then(({ code, data }) => {
            if (code === 200) {
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              if (i !== -1) {
                result.splice(i, 1, {
                  ...record,
                  status: CrontabStatus.running,
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

  const stopCron = (record: any, index: number) => {
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
          .put(`${config.apiPrefix}crons/stop`, [record.id])
          .then(({ code, data }) => {
            if (code === 200) {
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              if (i !== -1) {
                result.splice(i, 1, {
                  ...record,
                  pid: null,
                  status: CrontabStatus.idle,
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

  const enabledOrDisabledCron = (record: any, index: number) => {
    Modal.confirm({
      title: `确认${
        record.isDisabled === 1 ? intl.get('启用') : intl.get('禁用')
      }`,
      content: (
        <>
          {intl.get('确认')}
          {record.isDisabled === 1 ? intl.get('启用') : intl.get('禁用')}
          {intl.get('定时任务')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}crons/${
              record.isDisabled === 1 ? 'enable' : 'disable'
            }`,
            [record.id],
          )
          .then(({ code, data }) => {
            if (code === 200) {
              const newStatus = record.isDisabled === 1 ? 0 : 1;
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              if (i !== -1) {
                result.splice(i, 1, {
                  ...record,
                  isDisabled: newStatus,
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

  const pinOrUnPinCron = (record: any, index: number) => {
    Modal.confirm({
      title: `确认${
        record.isPinned === 1 ? intl.get('取消置顶') : intl.get('置顶')
      }`,
      content: (
        <>
          {intl.get('确认')}
          {record.isPinned === 1 ? intl.get('取消置顶') : intl.get('置顶')}
          {intl.get('定时任务')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}crons/${
              record.isPinned === 1 ? 'unpin' : 'pin'
            }`,
            [record.id],
          )
          .then(({ code, data }) => {
            if (code === 200) {
              const newStatus = record.isPinned === 1 ? 0 : 1;
              const result = [...value];
              const i = result.findIndex((x) => x.id === record.id);
              if (i !== -1) {
                result.splice(i, 1, {
                  ...record,
                  isPinned: newStatus,
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

  const getMenuItems = (record: any) => {
    return [
      { label: intl.get('编辑'), key: 'edit', icon: <EditOutlined /> },
      {
        label: record.isDisabled === 1 ? intl.get('启用') : intl.get('禁用'),
        key: 'enableOrDisable',
        icon:
          record.isDisabled === 1 ? <CheckCircleOutlined /> : <StopOutlined />,
      },
      { label: intl.get('删除'), key: 'delete', icon: <DeleteOutlined /> },
      {
        label: record.isPinned === 1 ? intl.get('取消置顶') : intl.get('置顶'),
        key: 'pinOrUnPin',
        icon: record.isPinned === 1 ? <StopOutlined /> : <PushpinOutlined />,
      },
    ];
  };

  const MoreBtn: React.FC<{
    record: any;
    index: number;
  }> = ({ record, index }) => (
    <Dropdown
      placement="bottomRight"
      trigger={['click']}
      menu={{
        items: getMenuItems(record),
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

  const handleCancel = () => {
    setIsModalVisible(false);
    getCrons();
  };

  const onSearch = (value: string) => {
    setSearchText(value.trim());
  };

  const getCronDetail = (cron: any) => {
    request
      .get(`${config.apiPrefix}crons/${cron.id}`)
      .then(({ code, data }) => {
        if (code === 200) {
          const index = value.findIndex((x) => x.id === cron.id);
          const result = [...value];
          data.nextRunTime = getCrontabsNextDate(
            data.schedule,
            data.extra_schedules,
          );
          if (index !== -1) {
            result.splice(index, 1, {
              ...cron,
              ...data,
            });
            setValue(result);
          }
        }
      })
      .finally(() => setLoading(false));
  };

  const onSelectChange = (selectedIds: any[]) => {
    setSelectedRowIds(selectedIds);
  };

  const rowSelection = {
    selectedRowKeys: selectedRowIds,
    onChange: onSelectChange,
  };

  const delCrons = () => {
    Modal.confirm({
      title: intl.get('确认删除'),
      content: <>{intl.get('确认删除选中的定时任务吗')}</>,
      onOk() {
        request
          .delete(`${config.apiPrefix}crons`, { data: selectedRowIds })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success(intl.get('批量删除成功'));
              setSelectedRowIds([]);
              getCrons();
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
      content: (
        <>
          {intl.get('确认')}
          {OperationName[operationStatus]}
          {intl.get('选中的定时任务吗')}
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}crons/${OperationPath[operationStatus]}`,
            selectedRowIds,
          )
          .then(({ code, data }) => {
            if (code === 200) {
              getCrons();
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const onPageChange = (
    pagination: TablePaginationConfig,
    filters: Record<string, FilterValue | null>,
    sorter: SorterResult<any> | SorterResult<any>[],
  ) => {
    const { current, pageSize } = pagination;
    setPageConf({
      page: current as number,
      size: pageSize as number,
      sorter,
      filters,
    });
    localStorage.setItem('pageSize', String(pageSize));
  };

  const getRowClassName = (record: any, index: number) => {
    return record.isPinned ? 'pinned-cron cron' : 'cron';
  };

  useEffect(() => {
    if (logCron) {
      localStorage.setItem('logCron', logCron.id);
      setIsLogModalVisible(true);
    }
  }, [logCron]);

  useEffect(() => {
    setPageConf({ ...pageConf, page: 1 });
  }, [searchText]);

  useEffect(() => {
    if (pageConf.page && pageConf.size) {
      getCrons();
    }
    if (viewConf && viewConf.id) {
      setActiveKey(viewConf.id);
    }
  }, [pageConf, viewConf]);

  useEffect(() => {
    if (viewConf && enabledCronViews && enabledCronViews.length > 0) {
      const view = enabledCronViews.slice(4).find((x) => x.id === viewConf.id);
      setMoreMenuActive(!!view);
    }
  }, [viewConf, enabledCronViews]);

  useEffect(() => {
    getCronViews();
  }, []);

  const viewAction = (key: string) => {
    switch (key) {
      case 'new':
        setIsCreateViewModalVisible(true);
        break;
      case 'manage':
        setIsViewManageModalVisible(true);
        break;

      default:
        tabClick(key);
        break;
    }
  };

  const menu: MenuProps = {
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      viewAction(key);
    },
    items: [
      ...[...enabledCronViews].slice(4).map((x) => ({
        label: (
          <Space style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{x.name}</span>
            {viewConf?.id === x.id && (
              <CheckOutlined style={{ color: '#1890ff' }} />
            )}
          </Space>
        ),
        key: x.id,
        icon: <UnorderedListOutlined />,
      })),
      {
        type: 'divider' as 'group',
      },
      {
        label: intl.get('创建视图'),
        key: 'new',
        icon: <PlusOutlined />,
      },
      {
        label: intl.get('视图管理'),
        key: 'manage',
        icon: <SettingOutlined />,
      },
    ],
  };

  const getCronViews = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}crons/views`)
      .then(({ code, data }) => {
        if (code === 200) {
          setCronViews(data);
          const firstEnableView = data
            .filter((x) => !x.isDisabled)
            .map((x) => ({
              ...x,
              name: x.name === '全部任务' ? intl.get('全部任务') : x.name,
            }));
          setEnabledCronViews(firstEnableView);
          setPageConf({
            page: 1,
            size: parseInt(localStorage.getItem('pageSize') || '20'),
            sorter: {},
            filters: {},
          });
          setViewConf({
            ...firstEnableView[0],
          });
        }
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const tabClick = (key: string) => {
    const view = enabledCronViews.find((x) => x.id == key);
    setSelectedRowIds([]);
    setPageConf({ ...pageConf, page: 1 });
    setViewConf(view ? view : null);
  };

  const [vt] = useVT(
    () => ({ scroll: { y: tableScrollHeight } }),
    [tableScrollHeight],
  );

  return (
    <PageContainer
      className="ql-container-wrapper crontab-wrapper ql-container-wrapper-has-tab"
      title={intl.get('定时任务')}
      extra={[
        <Search
          placeholder={intl.get('请输入名称或者关键词')}
          style={{ width: 'auto' }}
          enterButton
          allowClear
          loading={loading}
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onSearch={onSearch}
        />,
        <Button key="2" type="primary" onClick={() => addCron()}>
          {intl.get('创建任务')}
        </Button>,
      ]}
      header={{
        style: headerStyle,
      }}
    >
      <Tabs
        defaultActiveKey="all"
        size="small"
        activeKey={activeKey}
        tabPosition="top"
        className={`crontab-view ${moreMenuActive ? 'more-active' : ''}`}
        tabBarExtraContent={
          <Dropdown
            menu={menu}
            trigger={['click']}
            overlayStyle={{ minWidth: 200 }}
          >
            <div className={`view-more ${moreMenuActive ? 'active' : ''}`}>
              <Space>
                {intl.get('更多')}
                <DownOutlined />
              </Space>
              <div className="ant-tabs-ink-bar ant-tabs-ink-bar-animated"></div>
            </div>
          </Dropdown>
        }
        onTabClick={tabClick}
        items={[
          ...[...enabledCronViews].slice(0, 4).map((x) => ({
            key: x.id,
            label: x.name,
          })),
        ]}
      />
      <div ref={tableRef}>
        {selectedRowIds.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Button
              type="primary"
              style={{ marginBottom: 5 }}
              onClick={delCrons}
            >
              {intl.get('批量删除')}
            </Button>
            <Button
              type="primary"
              onClick={() => operateCrons(0)}
              style={{ marginLeft: 8, marginBottom: 5 }}
            >
              {intl.get('批量启用')}
            </Button>
            <Button
              type="primary"
              onClick={() => operateCrons(1)}
              style={{ marginLeft: 8, marginRight: 8 }}
            >
              {intl.get('批量禁用')}
            </Button>
            <Button
              type="primary"
              style={{ marginRight: 8 }}
              onClick={() => operateCrons(2)}
            >
              {intl.get('批量运行')}
            </Button>
            <Button type="primary" onClick={() => operateCrons(3)}>
              {intl.get('批量停止')}
            </Button>
            <Button
              type="primary"
              onClick={() => operateCrons(4)}
              style={{ marginLeft: 8, marginRight: 8 }}
            >
              {intl.get('批量置顶')}
            </Button>
            <Button
              type="primary"
              onClick={() => operateCrons(5)}
              style={{ marginLeft: 8, marginRight: 8 }}
            >
              {intl.get('批量取消置顶')}
            </Button>
            <Button
              type="primary"
              onClick={() => setIsLabelModalVisible(true)}
              style={{ marginLeft: 8, marginRight: 8 }}
            >
              {intl.get('批量修改标签')}
            </Button>
            <span style={{ marginLeft: 8 }}>
              {intl.get('已选择')}
              <a>{selectedRowIds?.length}</a>
              {intl.get('项')}
            </span>
          </div>
        )}
        <Table
          columns={columns}
          pagination={{
            current: pageConf.page,
            pageSize: pageConf.size,
            showSizeChanger: true,
            simple: isPhone,
            total,
            showTotal: (total: number, range: number[]) =>
              `第 ${range[0]}-${range[1]} 条/总共 ${total} 条`,
            pageSizeOptions: [10, 20, 50, 100, 200, 500, total || 10000].sort(
              (a, b) => a - b,
            ),
          }}
          dataSource={value}
          rowKey="id"
          size="middle"
          scroll={{ x: 1200, y: tableScrollHeight }}
          loading={loading}
          rowSelection={rowSelection}
          rowClassName={getRowClassName}
          onChange={onPageChange}
          components={isPhone || pageConf.size < 50 ? undefined : vt}
        />
      </div>
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
          setIsLabelModalVisible(false);
          if (needUpdate) {
            getCrons();
          }
        }}
        ids={selectedRowIds}
      />
      <CronDetailModal
        visible={isDetailModalVisible}
        handleCancel={() => {
          setIsDetailModalVisible(false);
        }}
        cron={detailCron}
        theme={theme}
        isPhone={isPhone}
      />
      <ViewCreateModal
        visible={isCreateViewModalVisible}
        handleCancel={(data) => {
          setIsCreateViewModalVisible(false);
          getCronViews();
        }}
      />
      <ViewManageModal
        cronViews={cronViews}
        visible={isViewManageModalVisible}
        handleCancel={() => {
          setIsViewManageModalVisible(false);
        }}
        cronViewChange={(data) => {
          getCronViews();
        }}
      />
    </PageContainer>
  );
};

export default Crontab;
