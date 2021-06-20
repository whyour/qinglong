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
import EnvModal from './modal';
import EditNameModal from './editNameModal';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import './index.less';

const { Text } = Typography;

enum Status {
  '已启用',
  '已禁用',
}

enum StatusColor {
  'success',
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

const Env = () => {
  const columns = [
    {
      title: '序号',
      align: 'center' as const,
      render: (text: string, record: any, index: number) => {
        return <span style={{ cursor: 'text' }}>{index + 1} </span>;
      },
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      align: 'center' as const,
    },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      align: 'center' as const,
      width: '45%',
      render: (text: string, record: any) => {
        return (
          <span
            style={{
              textAlign: 'left',
              display: 'inline-block',
              wordBreak: 'break-all',
              cursor: 'text',
              width: '100%',
            }}
          >
            {text}
          </span>
        );
      },
    },
    {
      title: '备注',
      dataIndex: 'remarks',
      key: 'remarks',
      align: 'center' as const,
    },
    {
      title: '状态',
      key: 'status',
      dataIndex: 'status',
      align: 'center' as const,
      width: 60,
      render: (text: string, record: any, index: number) => {
        return (
          <Space size="middle" style={{ cursor: 'text' }}>
            <Tag color={StatusColor[record.status]} style={{ marginRight: 0 }}>
              {Status[record.status]}
            </Tag>
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
            <a onClick={() => editEnv(record, index)}>
              <EditOutlined />
            </a>
          </Tooltip>
          <Tooltip title={record.status === Status.已禁用 ? '启用' : '禁用'}>
            <a onClick={() => enabledOrDisabledEnv(record, index)}>
              {record.status === Status.已禁用 ? (
                <CheckCircleOutlined />
              ) : (
                <StopOutlined />
              )}
            </a>
          </Tooltip>
          <Tooltip title="删除">
            <a onClick={() => deleteEnv(record, index)}>
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
  const [isEditNameModalVisible, setIsEditNameModalVisible] = useState(false);
  const [editedEnv, setEditedEnv] = useState();
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);

  const getEnvs = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}envs`)
      .then((data: any) => {
        setValue(data.data);
      })
      .finally(() => setLoading(false));
  };

  const enabledOrDisabledEnv = (record: any, index: number) => {
    Modal.confirm({
      title: `确认${record.status === Status.已禁用 ? '启用' : '禁用'}`,
      content: (
        <>
          确认{record.status === Status.已禁用 ? '启用' : '禁用'}
          Env{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.value}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}envs/${
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

  const addEnv = () => {
    setEditedEnv(null as any);
    setIsModalVisible(true);
  };

  const editEnv = (record: any, index: number) => {
    setEditedEnv(record);
    setIsModalVisible(true);
  };

  const deleteEnv = (record: any, index: number) => {
    Modal.confirm({
      title: '确认删除',
      content: (
        <>
          确认删除Env{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.value}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}envs`, { data: [record._id] })
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

  const handleCancel = (env?: any[]) => {
    setIsModalVisible(false);
    handleEnv(env);
  };

  const handleEditNameCancel = (env?: any[]) => {
    setIsEditNameModalVisible(false);
    getEnvs();
  };

  const handleEnv = (env: any) => {
    const result = [...value];
    const index = value.findIndex((x) => x._id === env._id);
    if (index === -1) {
      result.push(env);
    } else {
      result.splice(index, 1, {
        ...env,
      });
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
        .put(`${config.apiPrefix}envs/${dragRow._id}/move`, {
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

  const delEnvs = () => {
    Modal.confirm({
      title: '确认删除',
      content: <>确认删除选中的Env吗</>,
      onOk() {
        request
          .delete(`${config.apiPrefix}envs`, { data: selectedRowIds })
          .then((data: any) => {
            if (data.code === 200) {
              message.success('批量删除成功');
              setSelectedRowIds([]);
              getEnvs();
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

  const operateEnvs = (operationStatus: number) => {
    Modal.confirm({
      title: `确认${OperationName[operationStatus]}`,
      content: <>确认{OperationName[operationStatus]}选中的Env吗</>,
      onOk() {
        request
          .put(`${config.apiPrefix}envs/${OperationPath[operationStatus]}`, {
            data: selectedRowIds,
          })
          .then((data: any) => {
            if (data.code === 200) {
              getEnvs();
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

  const modifyName = () => {
    setIsEditNameModalVisible(true);
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
    getEnvs();
  }, []);

  return (
    <PageContainer
      className="env-wrapper"
      title="环境变量"
      extra={[
        <Button key="2" type="primary" onClick={() => addEnv()}>
          添加Env
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
            onClick={modifyName}
          >
            批量修改变量名称
          </Button>
          <Button
            type="primary"
            style={{ marginBottom: 5, marginLeft: 8 }}
            onClick={delEnvs}
          >
            批量删除
          </Button>
          <Button
            type="primary"
            onClick={() => operateEnvs(0)}
            style={{ marginLeft: 8, marginBottom: 5 }}
          >
            批量启用
          </Button>
          <Button
            type="primary"
            onClick={() => operateEnvs(1)}
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
      <EnvModal
        visible={isModalVisible}
        handleCancel={handleCancel}
        env={editedEnv}
      />
      <EditNameModal
        visible={isEditNameModalVisible}
        handleCancel={handleEditNameCancel}
        ids={selectedRowIds}
      />
    </PageContainer>
  );
};

export default Env;
