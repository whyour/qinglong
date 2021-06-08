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
} from 'antd';
import {
  EditOutlined,
  DeleteOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import QRCode from 'qrcode.react';
import CookieModal from './modal';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import './index.less';

const { Text } = Typography;

enum Status {
  '未获取',
  '正常',
  '已禁用',
  '已失效',
  '状态异常',
}

enum StatusColor {
  'default',
  'success',
  'warning',
  'error',
}

enum OperationName {
  '启用',
  '禁用',
}

enum OperationPath {
  'enable',
  'disable',
}

const type = 'DragableBodyRow';

const DragableBodyRow = ({
  index,
  moveRow,
  className,
  style,
  ...restProps
}: any) => {
  const ref = useRef();
  const [{ isOver, dropClassName }, drop] = useDrop(
    () => ({
      accept: type,
      collect: (monitor) => {
        const { index: dragIndex } = monitor.getItem() || ({} as any);
        if (dragIndex === index) {
          return {};
        }
        return {
          isOver: monitor.isOver(),
          dropClassName:
            dragIndex < index ? ' drop-over-downward' : ' drop-over-upward',
        };
      },
      drop: (item: any) => {
        moveRow(item.index, index);
      },
    }),
    [index],
  );
  const [, drag, preview] = useDrag(
    () => ({
      type,
      item: { index },
      collect: (monitor) => ({
        isDragging: monitor.isDragging(),
      }),
    }),
    [index],
  );
  drop(drag(ref));

  return (
    <tr
      ref={ref}
      className={`${className}${isOver ? dropClassName : ''}`}
      style={{ cursor: 'move', ...style }}
      {...restProps}
    >
      {restProps.children}
    </tr>
  );
};

const Config = () => {
  const columns = [
    {
      title: '序号',
      align: 'center' as const,
      render: (text: string, record: any, index: number) => {
        return <span style={{ cursor: 'text' }}>{index + 1} </span>;
      },
    },
    {
      title: '昵称',
      dataIndex: 'nickname',
      key: 'nickname',
      align: 'center' as const,
      width: '15%',
      render: (text: string, record: any, index: number) => {
        const match = record.value.match(/pt_pin=([^; ]+)(?=;?)/);
        const val = (match && match[1]) || '未匹配用户名';
        return (
          <span style={{ cursor: 'text' }}>{record.nickname || val} </span>
        );
      },
    },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      align: 'center' as const,
      width: '50%',
      render: (text: string, record: any) => {
        return (
          <span
            style={{
              textAlign: 'left',
              display: 'inline-block',
              wordBreak: 'break-all',
              cursor: 'text',
            }}
          >
            {text}
          </span>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      dataIndex: 'status',
      align: 'center' as const,
      width: '15%',
      render: (text: string, record: any, index: number) => {
        return (
          <Space size="middle" style={{ cursor: 'text' }}>
            <Tag
              color={StatusColor[record.status] || StatusColor[3]}
              style={{ marginRight: 0 }}
            >
              {Status[record.status]}
            </Tag>
            {record.status !== Status.已禁用 && (
              <Tooltip title="刷新">
                <a onClick={() => refreshStatus(record, index)}>
                  <SyncOutlined />
                </a>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      align: 'center' as const,
      render: (text: string, record: any, index: number) => (
        <Space size="middle">
          <Tooltip title="编辑">
            <a onClick={() => editCookie(record, index)}>
              <EditOutlined />
            </a>
          </Tooltip>
          <Tooltip title={record.status === Status.已禁用 ? '启用' : '禁用'}>
            <a onClick={() => enabledOrDisabledCookie(record, index)}>
              {record.status === Status.已禁用 ? (
                <CheckCircleOutlined />
              ) : (
                <StopOutlined />
              )}
            </a>
          </Tooltip>
          <Tooltip title="删除">
            <a onClick={() => deleteCookie(record, index)}>
              <DeleteOutlined />
            </a>
          </Tooltip>
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
  const [editedCookie, setEditedCookie] = useState();
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);

  const getCookies = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}cookies`)
      .then((data: any) => {
        setValue(data.data);
      })
      .finally(() => setLoading(false));
  };

  const refreshStatus = (record: any, index: number) => {
    request
      .get(`${config.apiPrefix}cookies/${record._id}/refresh`)
      .then(async (data: any) => {
        if (data.data && data.data.value) {
          (value as any).splice(index, 1, data.data);
          setValue([...(value as any)] as any);
        } else {
          message.error('更新状态失败');
        }
      });
  };

  const enabledOrDisabledCookie = (record: any, index: number) => {
    Modal.confirm({
      title: `确认${record.status === Status.已禁用 ? '启用' : '禁用'}`,
      content: (
        <>
          确认{record.status === Status.已禁用 ? '启用' : '禁用'}
          Cookie{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.value}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}cookies/${
              record.status === Status.已禁用 ? 'enable' : 'disable'
            }`,
            {
              data: [record._id],
            },
          )
          .then((data: any) => {
            if (data.code === 200) {
              message.success(
                `${record.status === Status.已禁用 ? '启用' : '禁用'}成功`,
              );
              const newStatus =
                record.status === Status.已禁用 ? Status.未获取 : Status.已禁用;
              const result = [...value];
              result.splice(index, 1, {
                ...record,
                status: newStatus,
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

  const addCookie = () => {
    setEditedCookie(null as any);
    setIsModalVisible(true);
  };

  const editCookie = (record: any, index: number) => {
    setEditedCookie(record);
    setIsModalVisible(true);
  };

  const deleteCookie = (record: any, index: number) => {
    Modal.confirm({
      title: '确认删除',
      content: (
        <>
          确认删除Cookie{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.value}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}cookies`, { data: [record._id] })
          .then((data: any) => {
            if (data.code === 200) {
              message.success('删除成功');
              const result = [...value];
              result.splice(index, 1);
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

  const handleCancel = (cookies?: any[]) => {
    setIsModalVisible(false);
    if (cookies && cookies.length > 0) {
      handleCookies(cookies);
    }
  };

  const handleCookies = (cookies: any[]) => {
    const result = [...value];
    for (let i = 0; i < cookies.length; i++) {
      const cookie = cookies[i];
      const index = value.findIndex((x) => x._id === cookie._id);
      if (index === -1) {
        result.push(cookie);
      } else {
        result.splice(index, 1, {
          ...cookie,
        });
      }
    }
    setValue(result);
  };

  const components = {
    body: {
      row: DragableBodyRow,
    },
  };

  const moveRow = useCallback(
    (dragIndex, hoverIndex) => {
      if (dragIndex === hoverIndex) {
        return;
      }
      const dragRow = value[dragIndex];
      const newData = [...value];
      newData.splice(dragIndex, 1);
      newData.splice(hoverIndex, 0, dragRow);
      setValue([...newData]);
      request
        .put(`${config.apiPrefix}cookies/${dragRow._id}/move`, {
          data: { fromIndex: dragIndex, toIndex: hoverIndex },
        })
        .then((data: any) => {
          if (data.code !== 200) {
            message.error(data);
          }
        });
    },
    [value],
  );

  const onSelectChange = (selectedIds: any[]) => {
    setSelectedRowIds(selectedIds);
  };

  const rowSelection = {
    selectedRowIds,
    onChange: onSelectChange,
  };

  const delCookies = () => {
    Modal.confirm({
      title: '确认删除',
      content: <>确认删除选中的Cookie吗</>,
      onOk() {
        request
          .delete(`${config.apiPrefix}cookies`, { data: selectedRowIds })
          .then((data: any) => {
            if (data.code === 200) {
              message.success('批量删除成功');
              setSelectedRowIds([]);
              getCookies();
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

  const operateCookies = (operationStatus: number) => {
    Modal.confirm({
      title: `确认${OperationName[operationStatus]}`,
      content: <>确认{OperationName[operationStatus]}选中的Cookie吗</>,
      onOk() {
        request
          .put(`${config.apiPrefix}cookies/${OperationPath[operationStatus]}`, {
            data: selectedRowIds,
          })
          .then((data: any) => {
            if (data.code === 200) {
              getCookies();
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
    getCookies();
  }, []);

  return (
    <PageContainer
      className="session-wrapper"
      title="Session管理"
      extra={[
        <Button key="2" type="primary" onClick={() => addCookie()}>
          添加Cookie
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
          <Button
            type="primary"
            style={{ marginBottom: 5 }}
            onClick={delCookies}
          >
            批量删除
          </Button>
          <Button
            type="primary"
            onClick={() => operateCookies(0)}
            style={{ marginLeft: 8, marginBottom: 5 }}
          >
            批量启用
          </Button>
          <Button
            type="primary"
            onClick={() => operateCookies(1)}
            style={{ marginLeft: 8, marginRight: 8 }}
          >
            批量禁用
          </Button>
          <span style={{ marginLeft: 8 }}>
            已选择
            <a>{selectedRowIds?.length}</a>项
          </span>
        </div>
      )}
      <DndProvider backend={HTML5Backend}>
        <Table
          columns={columns}
          rowSelection={rowSelection}
          pagination={false}
          dataSource={value}
          rowKey="_id"
          size="middle"
          scroll={{ x: 768 }}
          components={components}
          loading={loading}
          onRow={(record, index) => {
            return {
              index,
              moveRow,
            } as any;
          }}
        />
      </DndProvider>
      <CookieModal
        visible={isModalVisible}
        handleCancel={handleCancel}
        cookie={editedCookie}
      />
    </PageContainer>
  );
};

export default Config;
