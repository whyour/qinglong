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
  Tabs,
} from 'antd';
import {
  EditOutlined,
  DeleteOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  StopOutlined,
  BugOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import DependenceModal from './modal';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import './index.less';
import { getTableScroll } from '@/utils/index';
import DependenceLogModal from './logModal';

const { Text } = Typography;
const { Search } = Input;

enum Status {
  '安装中',
  '已安装',
  '安装失败',
}

enum StatusColor {
  'processing',
  'success',
  'error',
}

const Dependence = ({ headerStyle, isPhone, ws }: any) => {
  const columns: any = [
    {
      title: '序号',
      align: 'center' as const,
      width: 50,
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
      title: '状态',
      key: 'status',
      dataIndex: 'status',
      align: 'center' as const,
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
      title: '创建时间',
      key: 'created',
      dataIndex: 'created',
      align: 'center' as const,
      render: (text: string, record: any) => {
        return <span>{new Date(record.created).toLocaleString()}</span>;
      },
    },
    {
      title: '操作',
      key: 'action',
      align: 'center' as const,
      render: (text: string, record: any, index: number) => {
        const isPc = !isPhone;
        return (
          <Space size="middle">
            {record.status !== Status.安装中 && (
              <>
                <Tooltip title={isPc ? '重新安装' : ''}>
                  <a onClick={() => reInstallDependence(record, index)}>
                    <BugOutlined />
                  </a>
                </Tooltip>
                <Tooltip title={isPc ? '删除' : ''}>
                  <a onClick={() => deleteDependence(record, index)}>
                    <DeleteOutlined />
                  </a>
                </Tooltip>
              </>
            )}
            <Tooltip title={isPc ? '日志' : ''}>
              <a
                onClick={() => {
                  setLogDependence({ ...record, timestamp: Date.now() });
                }}
              >
                <FileTextOutlined />
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
  const [editedDependence, setEditedDependence] = useState();
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [tableScrollHeight, setTableScrollHeight] = useState<number>();
  const [logDependence, setLogDependence] = useState<any>();
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [type, setType] = useState('nodejs');

  const getDependencies = () => {
    setLoading(true);
    request
      .get(
        `${config.apiPrefix}dependencies?searchValue=${searchText}&type=${type}`,
      )
      .then((data: any) => {
        setValue(data.data);
      })
      .finally(() => setLoading(false));
  };

  const addDependence = () => {
    setEditedDependence(null as any);
    setIsModalVisible(true);
  };

  const editDependence = (record: any, index: number) => {
    setEditedDependence(record);
    setIsModalVisible(true);
  };

  const deleteDependence = (record: any, index: number) => {
    Modal.confirm({
      title: '确认删除',
      content: (
        <>
          确认删除依赖{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}dependencies`, { data: [record._id] })
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

  const reInstallDependence = (record: any, index: number) => {
    Modal.confirm({
      title: '确认重新安装',
      content: (
        <>
          确认重新安装{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}dependencies/reinstall`, {
            data: [record._id],
          })
          .then((data: any) => {
            if (data.code === 200) {
              handleDependence(data.data[0]);
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

  const handleCancel = (dependence?: any[]) => {
    setIsModalVisible(false);
    dependence && handleDependence(dependence);
  };

  const handleDependence = (dependence: any) => {
    const result = [...value];
    if (Array.isArray(dependence)) {
      result.push(...dependence);
    } else {
      const index = value.findIndex((x) => x._id === dependence._id);
      result.splice(index, 1, {
        ...dependence,
      });
    }
    setValue(result);
  };

  const onSelectChange = (selectedIds: any[]) => {
    setSelectedRowIds(selectedIds);

    setTimeout(() => {
      if (selectedRowIds.length === 0 || selectedIds.length === 0) {
        const offset = isPhone ? 40 : 0;
        setTableScrollHeight(getTableScroll({ extraHeight: 87 }) - offset);
      }
    });
  };

  const rowSelection = {
    selectedRowIds,
    onChange: onSelectChange,
  };

  const delDependencies = () => {
    Modal.confirm({
      title: '确认删除',
      content: <>确认删除选中的变量吗</>,
      onOk() {
        request
          .delete(`${config.apiPrefix}dependencies`, { data: selectedRowIds })
          .then((data: any) => {
            if (data.code === 200) {
              message.success('批量删除成功');
              setSelectedRowIds([]);
              getDependencies();
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

  const getDependenceDetail = (dependence: any) => {
    request
      .get(`${config.apiPrefix}dependencies/${dependence._id}`)
      .then((data: any) => {
        const index = value.findIndex((x) => x._id === dependence._id);
        const result = [...value];
        result.splice(index, 1, {
          ...dependence,
          ...data.data,
        });
        setValue(result);
      })
      .finally(() => setLoading(false));
  };

  const onSearch = (value: string) => {
    setSearchText(value.trim());
  };

  useEffect(() => {
    getDependencies();
  }, [searchText, type]);

  useEffect(() => {
    const offset = isPhone ? 40 : 0;
    setTableScrollHeight(getTableScroll({ extraHeight: 87 }) - offset);
  }, []);

  useEffect(() => {
    if (logDependence) {
      localStorage.setItem('logDependence', logDependence._id);
      setIsLogModalVisible(true);
    }
  }, [logDependence]);

  useEffect(() => {
    ws.onmessage = (e: any) => {
      const { type, message, references } = JSON.parse(e.data);
      if (
        type === 'installDependence' &&
        message === '依赖安装结束' &&
        references.length > 0
      ) {
        const result = [...value];
        for (let i = 0; i < references.length; i++) {
          const index = value.findIndex((x) => x._id === references[i]);
          result.splice(index, 1, {
            ...result[index],
            status: Status.已安装,
          });
        }
        setValue(result);
      }
    };
  }, [value]);

  const panelContent = () => (
    <>
      {selectedRowIds.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Button
            type="primary"
            style={{ marginBottom: 5, marginLeft: 8 }}
            onClick={delDependencies}
          >
            批量删除
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
          scroll={{ x: 768, y: tableScrollHeight }}
          loading={loading}
        />
      </DndProvider>
    </>
  );

  const onTabChange = (activeKey: string) => {
    setType(activeKey);
  };

  return (
    <PageContainer
      className="ql-container-wrapper dependence-wrapper"
      title="依赖管理"
      extra={[
        <Search
          placeholder="请输入名称"
          style={{ width: 'auto' }}
          enterButton
          loading={loading}
          onSearch={onSearch}
        />,
        <Button key="2" type="primary" onClick={() => addDependence()}>
          添加依赖
        </Button>,
      ]}
      header={{
        style: headerStyle,
      }}
    >
      <Tabs
        defaultActiveKey="nodejs"
        size="small"
        tabPosition="top"
        onChange={onTabChange}
      >
        <Tabs.TabPane tab="nodejs" key="nodejs">
          {panelContent()}
        </Tabs.TabPane>
        <Tabs.TabPane tab="python3" key="python3">
          {panelContent()}
        </Tabs.TabPane>
        <Tabs.TabPane tab="linux" key="linux">
          {panelContent()}
        </Tabs.TabPane>
      </Tabs>
      <DependenceModal
        visible={isModalVisible}
        handleCancel={handleCancel}
        dependence={editedDependence}
        defaultType={type}
      />
      <DependenceLogModal
        visible={isLogModalVisible}
        handleCancel={() => {
          setIsLogModalVisible(false);
          getDependenceDetail(logDependence);
        }}
        ws={ws}
        dependence={logDependence}
      />
    </PageContainer>
  );
};

export default Dependence;
