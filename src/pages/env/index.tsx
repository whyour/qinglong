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
  Input,
  UploadProps,
  Upload,
} from 'antd';
import {
  EditOutlined,
  DeleteOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  StopOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import EnvModal from './modal';
import EditNameModal from './editNameModal';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import './index.less';
import { exportJson, getTableScroll } from '@/utils/index';
import { useOutletContext } from '@umijs/max';
import { SharedContext } from '@/layouts';

const { Text, Paragraph } = Typography;
const { Search } = Input;

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
  const [{ isOver, dropClassName }, drop] = useDrop({
    accept: type,
    collect: (monitor) => {
      const { index: dragIndex } = (monitor.getItem() as any) || {};
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
  });
  const [, drag] = useDrag({
    type,
    item: { index },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });
  drop(drag(ref));

  return (
    <tr
      ref={ref}
      className={`${className}${isOver ? dropClassName : ''}`}
      style={{ cursor: 'move', ...style }}
      {...restProps}
    />
  );
};

const Env = () => {
  const { headerStyle, isPhone, theme } = useOutletContext<SharedContext>();
  const columns: any = [
    {
      title: '序号',
      align: 'center' as const,
      width: 60,
      render: (text: string, record: any, index: number) => {
        return <span style={{ cursor: 'text' }}>{index + 1} </span>;
      },
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      align: 'center' as const,
      sorter: (a: any, b: any) => a.name.localeCompare(b.name),
    },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      align: 'center' as const,
      width: '35%',
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
      title: '备注',
      dataIndex: 'remarks',
      key: 'remarks',
      align: 'center' as const,
    },
    {
      title: '更新时间',
      dataIndex: 'timestamp',
      key: 'timestamp',
      align: 'center' as const,
      width: 165,
      ellipsis: {
        showTitle: false,
      },
      sorter: {
        compare: (a: any, b: any) => {
          const updatedAtA = new Date(a.updatedAt || a.timestamp).getTime();
          const updatedAtB = new Date(b.updatedAt || b.timestamp).getTime();
          return updatedAtA - updatedAtB;
        },
      },
      render: (text: string, record: any) => {
        const language = navigator.language || navigator.languages[0];
        const time = record.updatedAt || record.timestamp;
        const date = new Date(time)
          .toLocaleString(language, {
            hour12: false,
          })
          .replace(' 24:', ' 00:');
        return (
          <Tooltip
            placement="topLeft"
            title={date}
            trigger={['hover', 'click']}
          >
            <span>{date}</span>
          </Tooltip>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      dataIndex: 'status',
      align: 'center' as const,
      width: 70,
      filters: [
        {
          text: '已启用',
          value: 0,
        },
        {
          text: '已禁用',
          value: 1,
        },
      ],
      onFilter: (value: number, record: any) => record.status === value,
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
      width: 120,
      align: 'center' as const,
      render: (text: string, record: any, index: number) => {
        const isPc = !isPhone;
        return (
          <Space size="middle">
            <Tooltip title={isPc ? '编辑' : ''}>
              <a onClick={() => editEnv(record, index)}>
                <EditOutlined />
              </a>
            </Tooltip>
            <Tooltip
              title={
                isPc ? (record.status === Status.已禁用 ? '启用' : '禁用') : ''
              }
            >
              <a onClick={() => enabledOrDisabledEnv(record, index)}>
                {record.status === Status.已禁用 ? (
                  <CheckCircleOutlined />
                ) : (
                  <StopOutlined />
                )}
              </a>
            </Tooltip>
            <Tooltip title={isPc ? '删除' : ''}>
              <a onClick={() => deleteEnv(record, index)}>
                <DeleteOutlined />
              </a>
            </Tooltip>
          </Space>
        );
      },
    },
  ];
  const [value, setValue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isEditNameModalVisible, setIsEditNameModalVisible] = useState(false);
  const [editedEnv, setEditedEnv] = useState();
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [tableScrollHeight, setTableScrollHeight] = useState<number>();
  const [importLoading, setImportLoading] = useState(false);

  const getEnvs = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}envs?searchValue=${searchText}`)
      .then(({ code, data }) => {
        if (code === 200) {
          setValue(data);
        }
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
              data: [record.id],
            },
          )
          .then(({ code, data }) => {
            if (code === 200) {
              message.success(
                `${record.status === Status.已禁用 ? '启用' : '禁用'}成功`,
              );
              const newStatus =
                record.status === Status.已禁用 ? Status.已启用 : Status.已禁用;
              const result = [...value];
              result.splice(index, 1, {
                ...record,
                status: newStatus,
              });
              setValue(result);
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
          确认删除变量{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}: {record.value}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}envs`, { data: [record.id] })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success('删除成功');
              const result = [...value];
              result.splice(index, 1);
              setValue(result);
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
    env && handleEnv(env);
  };

  const handleEditNameCancel = (env?: any[]) => {
    setIsEditNameModalVisible(false);
    getEnvs();
  };

  const handleEnv = (env: any) => {
    const result = [...value];
    const index = value.findIndex((x) => x.id === env.id);
    if (index === -1) {
      env = Array.isArray(env) ? env : [env];
      result.push(...env);
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
      request
        .put(`${config.apiPrefix}envs/${dragRow.id}/move`, {
          data: { fromIndex: dragIndex, toIndex: hoverIndex },
        })
        .then(({ code, data }) => {
          if (code === 200) {
            const newData = [...value];
            newData.splice(dragIndex, 1);
            newData.splice(hoverIndex, 0, { ...dragRow, ...data.data });
            setValue([...newData]);
          }
        });
    },
    [value],
  );

  const onSelectChange = (selectedIds: any[]) => {
    setSelectedRowIds(selectedIds);

    setTimeout(() => {
      if (selectedRowIds.length === 0 || selectedIds.length === 0) {
        setTableScrollHeight(getTableScroll({ extraHeight: 87 }));
      }
    });
  };

  const rowSelection = {
    selectedRowIds,
    onChange: onSelectChange,
  };

  const delEnvs = () => {
    Modal.confirm({
      title: '确认删除',
      content: <>确认删除选中的变量吗</>,
      onOk() {
        request
          .delete(`${config.apiPrefix}envs`, { data: selectedRowIds })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success('批量删除成功');
              setSelectedRowIds([]);
              getEnvs();
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
      content: <>确认{OperationName[operationStatus]}选中的变量吗</>,
      onOk() {
        request
          .put(`${config.apiPrefix}envs/${OperationPath[operationStatus]}`, {
            data: selectedRowIds,
          })
          .then(({ code, data }) => {
            if (code === 200) {
              getEnvs();
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const exportEnvs = () => {
    const envs = value
      .filter((x) => selectedRowIds.includes(x.id))
      .map((x) => ({ value: x.value, name: x.name, remarks: x.remarks }));
    exportJson('env.json', JSON.stringify(envs));
  };

  const modifyName = () => {
    setIsEditNameModalVisible(true);
  };

  const onSearch = (value: string) => {
    setSearchText(value.trim());
  };

  const uploadProps: UploadProps = {
    accept: 'application/json',
    beforeUpload: async (file) => {
      const formData = new FormData();
      formData.append('env', file);
      setImportLoading(true);
      try {
        const { code, data } = await request.post(
          `${config.apiPrefix}envs/upload`,
          {
            data: formData,
          },
        );

        if (code === 200) {
          message.success(`成功上传${data.length}个环境变量`);
          getEnvs();
        }
        setImportLoading(false);
      } catch (error: any) {
        setImportLoading(false);
      }
      return false;
    },
    fileList: [],
  };

  useEffect(() => {
    getEnvs();
  }, [searchText]);

  useEffect(() => {
    setTimeout(() => {
      setTableScrollHeight(getTableScroll({ extraHeight: 87 }));
    });
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper env-wrapper"
      title="环境变量"
      extra={[
        <Search
          placeholder="请输入名称/值/备注"
          style={{ width: 'auto' }}
          enterButton
          loading={loading}
          onSearch={onSearch}
        />,
        <Button key="2" type="primary" onClick={() => addEnv()}>
          新建变量
        </Button>,
        <Upload {...uploadProps}>
          <Button
            type="primary"
            icon={<UploadOutlined />}
            loading={importLoading}
          >
            导入
          </Button>
        </Upload>,
      ]}
      header={{
        style: headerStyle,
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
            onClick={() => exportEnvs()}
            style={{ marginLeft: 8, marginRight: 8 }}
          >
            批量导出
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
          rowKey="id"
          size="middle"
          scroll={{ x: 1000, y: tableScrollHeight }}
          components={components}
          loading={loading}
          onRow={(record: any, index: number) => {
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
