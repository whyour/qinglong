import React, { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  message,
  Dropdown,
  MenuProps,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  ApartmentOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-layout';
import intl from 'react-intl-universal';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { Scenario, WorkflowGraph } from './type';
import ScenarioModal from './modal';
import WorkflowEditorModal from './workflowEditorModal';
import './index.less';
import { useOutletContext } from '@umijs/max';
import { SharedContext } from '@/layouts';

const { Search } = Input;
const { Text } = Typography;

const ScenarioPage: React.FC = () => {
  const { headerStyle } = useOutletContext<SharedContext>();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isWorkflowModalVisible, setIsWorkflowModalVisible] = useState(false);
  const [editingScenario, setEditingScenario] = useState<Scenario | undefined>(
    undefined,
  );
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  useEffect(() => {
    fetchScenarios();
  }, []);

  const fetchScenarios = async (search?: string) => {
    setLoading(true);
    try {
      const { code, data } = await request.get(
        `${config.apiPrefix}scenarios`,
        {
          params: { searchValue: search || searchValue },
        },
      );
      if (code === 200) {
        setScenarios(data?.data || []);
      }
    } catch (error) {
      message.error(intl.get('获取场景列表失败'));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditingScenario(undefined);
    setIsModalVisible(true);
  };

  const handleEdit = (scenario: Scenario) => {
    setEditingScenario(scenario);
    setIsModalVisible(true);
  };

  const handleEditWorkflow = (scenario: Scenario) => {
    setEditingScenario(scenario);
    setIsWorkflowModalVisible(true);
  };

  const handleDelete = (ids: number[]) => {
    Modal.confirm({
      title: intl.get('确认删除场景'),
      content: intl.get('确认删除选中的场景吗'),
      onOk: async () => {
        try {
          const { code } = await request.delete(
            `${config.apiPrefix}scenarios`,
            { data: ids },
          );
          if (code === 200) {
            message.success(`${intl.get('删除')}成功`);
            fetchScenarios();
            setSelectedRowKeys([]);
          }
        } catch (error) {
          message.error(`${intl.get('删除')}失败`);
        }
      },
    });
  };

  const handleStatusChange = async (ids: number[], status: 0 | 1) => {
    try {
      const endpoint =
        status === 1
          ? `${config.apiPrefix}scenarios/enable`
          : `${config.apiPrefix}scenarios/disable`;
      const { code } = await request.put(endpoint, ids);
      if (code === 200) {
        message.success(
          `${status === 1 ? intl.get('启用场景') : intl.get('禁用场景')}成功`,
        );
        fetchScenarios();
        setSelectedRowKeys([]);
      }
    } catch (error) {
      message.error(
        `${status === 1 ? intl.get('启用场景') : intl.get('禁用场景')}失败`,
      );
    }
  };

  const handleModalOk = async (values: Scenario) => {
    try {
      const isEdit = !!editingScenario?.id;
      const endpoint = `${config.apiPrefix}scenarios`;
      const method = isEdit ? 'put' : 'post';
      const payload = isEdit ? { ...values, id: editingScenario.id } : values;

      const { code } = await request[method](endpoint, payload);
      if (code === 200) {
        message.success(
          `${isEdit ? intl.get('编辑') : intl.get('新建')}${intl.get('场景')}成功`,
        );
        setIsModalVisible(false);
        fetchScenarios();
      }
    } catch (error) {
      message.error(
        `${editingScenario ? intl.get('编辑') : intl.get('新建')}${intl.get('场景')}失败`,
      );
    }
  };

  const handleWorkflowModalOk = async (graph: WorkflowGraph) => {
    if (!editingScenario) return;

    try {
      const { code } = await request.put(`${config.apiPrefix}scenarios`, {
        id: editingScenario.id,
        name: editingScenario.name,
        description: editingScenario.description,
        workflowGraph: graph,
      });

      if (code === 200) {
        message.success(`${intl.get('保存工作流')}成功`);
        setIsWorkflowModalVisible(false);
        fetchScenarios();
      }
    } catch (error) {
      message.error(`${intl.get('保存工作流')}失败`);
    }
  };

  const getRowMenuItems = (record: Scenario): MenuProps['items'] => [
    {
      key: 'edit',
      icon: <EditOutlined />,
      label: intl.get('编辑'),
      onClick: () => handleEdit(record),
    },
    {
      key: 'workflow',
      icon: <ApartmentOutlined />,
      label: intl.get('编辑工作流'),
      onClick: () => handleEditWorkflow(record),
    },
    {
      key: 'status',
      icon:
        record.status === 1 ? <CloseCircleOutlined /> : <CheckCircleOutlined />,
      label: record.status === 1 ? intl.get('禁用场景') : intl.get('启用场景'),
      onClick: () =>
        handleStatusChange([record.id!], record.status === 1 ? 0 : 1),
    },
    {
      type: 'divider',
    },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: intl.get('删除'),
      danger: true,
      onClick: () => handleDelete([record.id!]),
    },
  ];

  const columns = [
    {
      title: intl.get('场景名称'),
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (text: string) => <Text strong>{text}</Text>,
    },
    {
      title: intl.get('场景描述'),
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: intl.get('状态'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: number) => (
        <Tag color={status === 1 ? 'success' : 'error'}>
          {status === 1 ? intl.get('已启用') : intl.get('已禁用')}
        </Tag>
      ),
    },
    {
      title: intl.get('工作流'),
      dataIndex: 'workflowGraph',
      key: 'workflowGraph',
      width: 150,
      render: (graph: WorkflowGraph) => (
        <Text type="secondary">
          {graph?.nodes?.length || 0} {intl.get('节点')}
        </Text>
      ),
    },
    {
      title: intl.get('创建时间'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 200,
      render: (date: string) =>
        date ? new Date(date).toLocaleString() : '-',
    },
    {
      title: intl.get('操作'),
      key: 'action',
      width: 200,
      render: (_: any, record: Scenario) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<ApartmentOutlined />}
            onClick={() => handleEditWorkflow(record)}
          >
            {intl.get('编辑工作流')}
          </Button>
          <Dropdown menu={{ items: getRowMenuItems(record) }}>
            <Button type="link" size="small" icon={<EllipsisOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys),
  };

  return (
    <PageContainer
      className="ql-container-wrapper scenario-wrapper"
      title={intl.get('场景管理')}
      header={{
        style: headerStyle,
      }}
      extra={[
        <Search
          placeholder={intl.get('搜索场景')}
          style={{ width: 300 }}
          onSearch={(value) => {
            setSearchValue(value);
            fetchScenarios(value);
          }}
          allowClear
        />,
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleCreate}
        >
          {intl.get('新建场景')}
        </Button>,
      ]}
    >
      <div className="scenario-page">
        {selectedRowKeys.length > 0 && (
          <div className="scenario-toolbar">
            <Button
              type="primary"
              onClick={() =>
                handleStatusChange(selectedRowKeys as number[], 1)
              }
            >
              {intl.get('批量启用')}
            </Button>
            <Button
              type="primary"
              onClick={() =>
                handleStatusChange(selectedRowKeys as number[], 0)
              }
            >
              {intl.get('批量禁用')}
            </Button>
            <Button
              danger
              type="primary"
              onClick={() => handleDelete(selectedRowKeys as number[])}
            >
              {intl.get('批量删除')}
            </Button>
          </div>
        )}

        <Table
          rowKey="id"
          columns={columns}
          dataSource={scenarios}
          loading={loading}
          rowSelection={rowSelection}
          pagination={{
            showSizeChanger: true,
            showTotal: (total) => `${intl.get('共')} ${total} ${intl.get('条')}`,
          }}
        />

        <ScenarioModal
          visible={isModalVisible}
          scenario={editingScenario}
          onOk={handleModalOk}
          onCancel={() => setIsModalVisible(false)}
        />

        <WorkflowEditorModal
          visible={isWorkflowModalVisible}
          workflowGraph={editingScenario?.workflowGraph}
          onOk={handleWorkflowModalOk}
          onCancel={() => setIsWorkflowModalVisible(false)}
        />
      </div>
    </PageContainer>
  );
};

export default ScenarioPage;
