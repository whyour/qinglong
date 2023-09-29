import intl from 'react-intl-universal';
import React, {
  useCallback,
  useRef,
  useState,
  useEffect,
  useMemo,
} from 'react';
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
import { exportJson } from '@/utils/index';
import { useOutletContext } from '@umijs/max';
import { SharedContext } from '@/layouts';
import useTableScrollHeight from '@/hooks/useTableScrollHeight';
import Copy from '../../components/copy';
import { useVT } from 'virtualizedtableforantd4';
import dayjs from 'dayjs';

const { Paragraph } = Typography;
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

const Env = () => {
  const { headerStyle, isPhone, theme } = useOutletContext<SharedContext>();
  const columns: any = [
    {
      title: intl.get('序号'),
      width: 80,
      render: (text: string, record: any, index: number) => {
        return <span style={{ cursor: 'text' }}>{index + 1} </span>;
      },
    },
    {
      title: intl.get('名称'),
      dataIndex: 'name',
      key: 'name',
      sorter: (a: any, b: any) => a.name.localeCompare(b.name),
      render: (text: string, record: any) => {
        return (
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <Tooltip title={text} placement="topLeft">
              <div className="text-ellipsis">{text}</div>
            </Tooltip>
            <Copy text={text} />
          </div>
        );
      },
    },
    {
      title: intl.get('值'),
      dataIndex: 'value',
      key: 'value',
      width: '35%',
      render: (text: string, record: any) => {
        return (
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <Tooltip title={text} placement="topLeft">
              <div className="text-ellipsis">{text}</div>
            </Tooltip>
            <Copy text={text} />
          </div>
        );
      },
    },
    {
      title: intl.get('备注'),
      dataIndex: 'remarks',
      key: 'remarks',
      render: (text: string, record: any) => {
        return (
          <Tooltip title={text} placement="topLeft">
            <div className="text-ellipsis">{text}</div>
          </Tooltip>
        );
      },
    },
    {
      title: intl.get('更新时间'),
      dataIndex: 'timestamp',
      key: 'timestamp',
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
        const date = dayjs(record.updatedAt || record.timestamp).format(
          'YYYY-MM-DD HH:mm:ss',
        );
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
      title: intl.get('状态'),
      key: 'status',
      dataIndex: 'status',
      width: 100,
      filters: [
        {
          text: intl.get('已启用'),
          value: 0,
        },
        {
          text: intl.get('已禁用'),
          value: 1,
        },
      ],
      onFilter: (value: number, record: any) => record.status === value,
      render: (text: string, record: any, index: number) => {
        return (
          <Space size="middle" style={{ cursor: 'text' }}>
            <Tag color={StatusColor[record.status]} style={{ marginRight: 0 }}>
              {intl.get(Status[record.status])}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: intl.get('操作'),
      key: 'action',
      width: 120,
      render: (text: string, record: any, index: number) => {
        const isPc = !isPhone;
        return (
          <Space size="middle">
            <Tooltip title={isPc ? intl.get('编辑') : ''}>
              <a onClick={() => editEnv(record, index)}>
                <EditOutlined />
              </a>
            </Tooltip>
            <Tooltip
              title={
                isPc
                  ? record.status === Status.已禁用
                    ? intl.get('启用')
                    : intl.get('禁用')
                  : ''
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
            <Tooltip title={isPc ? intl.get('删除') : ''}>
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
  const [importLoading, setImportLoading] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const tableScrollHeight = useTableScrollHeight(tableRef, 59);

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
      title: `确认${
        record.status === Status.已禁用 ? intl.get('启用') : intl.get('禁用')
      }`,
      content: (
        <>
          {intl.get('确认')}
          {record.status === Status.已禁用
            ? intl.get('启用')
            : intl.get('禁用')}
          Env{' '}
          <Paragraph
            style={{ wordBreak: 'break-all', display: 'inline' }}
            ellipsis={{ rows: 6, expandable: true }}
            type="warning"
            copyable
          >
            {record.value}
          </Paragraph>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}envs/${
              record.status === Status.已禁用 ? 'enable' : 'disable'
            }`,
            [record.id],
          )
          .then(({ code, data }) => {
            if (code === 200) {
              message.success(
                `${
                  record.status === Status.已禁用
                    ? intl.get('启用')
                    : intl.get('禁用')
                }${intl.get('成功')}`,
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
      title: intl.get('确认删除'),
      content: (
        <>
          {intl.get('确认删除变量')}{' '}
          <Paragraph
            style={{ wordBreak: 'break-all', display: 'inline' }}
            ellipsis={{ rows: 6, expandable: true }}
            type="warning"
            copyable
          >
            {record.name}: {record.value}
          </Paragraph>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}envs`, { data: [record.id] })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success(intl.get('删除成功'));
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
    getEnvs();
  };

  const handleEditNameCancel = (env?: any[]) => {
    setIsEditNameModalVisible(false);
    getEnvs();
  };

  const [vt, setVT] = useVT(
    () => ({ scroll: { y: tableScrollHeight } }),
    [tableScrollHeight],
  );

  const DragableBodyRow = React.forwardRef((props: any, ref) => {
    const { index, moveRow, className, style, ...restProps } = props;
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

    useEffect(() => {
      drop(drag(ref));
    }, [ref]);

    return (
      <tr
        ref={ref}
        className={`${className}${isOver ? dropClassName : ''}`}
        style={{ cursor: 'move', ...style }}
        {...restProps}
      />
    );
  });

  useEffect(
    () =>
      setVT({
        body: {
          row: DragableBodyRow,
        },
      }),
    [],
  );

  const moveRow = useCallback(
    (dragIndex: number, hoverIndex: number) => {
      if (dragIndex === hoverIndex) {
        return;
      }
      const dragRow = value[dragIndex];
      request
        .put(`${config.apiPrefix}envs/${dragRow.id}/move`, {
          fromIndex: dragIndex,
          toIndex: hoverIndex,
        })
        .then(({ code, data }) => {
          if (code === 200) {
            const newData = [...value];
            newData.splice(dragIndex, 1);
            newData.splice(hoverIndex, 0, { ...dragRow, ...data });
            setValue([...newData]);
          }
        });
    },
    [value],
  );

  const onSelectChange = (selectedIds: any[]) => {
    setSelectedRowIds(selectedIds);
  };

  const rowSelection = {
    selectedRowKeys: selectedRowIds,
    onChange: onSelectChange,
  };

  const delEnvs = () => {
    Modal.confirm({
      title: intl.get('确认删除'),
      content: <>{intl.get('确认删除选中的变量吗')}</>,
      onOk() {
        request
          .delete(`${config.apiPrefix}envs`, { data: selectedRowIds })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success(intl.get('批量删除成功'));
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
      content: (
        <>
          {intl.get('确认')}
          {OperationName[operationStatus]}
          {intl.get('选中的变量吗')}
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}envs/${OperationPath[operationStatus]}`,
            selectedRowIds,
          )
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
          formData,
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

  return (
    <PageContainer
      className="ql-container-wrapper env-wrapper"
      title={intl.get('环境变量')}
      extra={[
        <Search
          placeholder={intl.get('请输入名称/值/备注')}
          style={{ width: 'auto' }}
          enterButton
          loading={loading}
          onSearch={onSearch}
        />,
        <Upload {...uploadProps}>
          <Button
            type="primary"
            icon={<UploadOutlined />}
            loading={importLoading}
          >
            {intl.get('导入')}
          </Button>
        </Upload>,
        <Button key="2" type="primary" onClick={() => addEnv()}>
          {intl.get('创建变量')}
        </Button>,
      ]}
      header={{
        style: headerStyle,
      }}
    >
      <div ref={tableRef}>
        {selectedRowIds.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Button
              type="primary"
              style={{ marginBottom: 5 }}
              onClick={modifyName}
            >
              {intl.get('批量修改变量名称')}
            </Button>
            <Button
              type="primary"
              style={{ marginBottom: 5, marginLeft: 8 }}
              onClick={delEnvs}
            >
              {intl.get('批量删除')}
            </Button>
            <Button
              type="primary"
              onClick={() => exportEnvs()}
              style={{ marginLeft: 8, marginRight: 8 }}
            >
              {intl.get('批量导出')}
            </Button>
            <Button
              type="primary"
              onClick={() => operateEnvs(0)}
              style={{ marginLeft: 8, marginBottom: 5 }}
            >
              {intl.get('批量启用')}
            </Button>
            <Button
              type="primary"
              onClick={() => operateEnvs(1)}
              style={{ marginLeft: 8, marginRight: 8 }}
            >
              {intl.get('批量禁用')}
            </Button>
            <span style={{ marginLeft: 8 }}>
              {intl.get('已选择')}
              <a>{selectedRowIds?.length}</a>
              {intl.get('项')}
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
            scroll={{ x: 1200, y: tableScrollHeight }}
            components={vt}
            loading={loading}
            onRow={(record: any, index: number | undefined) => {
              return {
                index,
                moveRow,
              } as any;
            }}
          />
        </DndProvider>
      </div>
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
