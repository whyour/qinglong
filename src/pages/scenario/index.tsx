import React, { useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-layout';
import {
  Button,
  Table,
  Space,
  Modal,
  message,
  Tag,
  Switch,
  Tooltip,
  Dropdown,
  MenuProps,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  EllipsisOutlined,
  FileTextOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { request } from '@/utils/http';
import intl from 'react-intl-universal';
import ScenarioModal from './flowgramWorkflowModal';
import ScenarioLogModal from './logModal';
import dayjs from 'dayjs';

const Scenario = () => {
  const [loading, setLoading] = useState(false);
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<any>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);

  const fetchScenarios = async () => {
    setLoading(true);
    try {
      const { code, data } = await request.get('/api/scenarios');
      if (code === 200) {
        setScenarios(data || []);
      }
    } catch (error) {
      console.error('Failed to fetch scenarios:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchScenarios();
  }, []);

  const handleCreate = () => {
    setSelectedScenario(null);
    setIsModalVisible(true);
  };

  const handleEdit = (record: any) => {
    setSelectedScenario(record);
    setIsModalVisible(true);
  };

  const handleDelete = (record: any) => {
    Modal.confirm({
      title: intl.get('确认删除'),
      content: `${intl.get('确定要删除场景')} "${record.name}" ${intl.get('吗')}?`,
      onOk: async () => {
        try {
          const { code } = await request.delete('/api/scenarios', {
            data: [record.id],
          });
          if (code === 200) {
            message.success(intl.get('删除成功'));
            fetchScenarios();
          }
        } catch (error) {
          console.error('Failed to delete scenario:', error);
        }
      },
    });
  };

  const handleToggleEnabled = async (record: any) => {
    try {
      const { code } = await request.put('/api/scenarios', {
        id: record.id,
        isEnabled: record.isEnabled === 1 ? 0 : 1,
      });
      if (code === 200) {
        message.success(intl.get('更新成功'));
        fetchScenarios();
      }
    } catch (error) {
      console.error('Failed to toggle scenario:', error);
    }
  };

  const handleTrigger = async (record: any) => {
    try {
      const { code } = await request.post(`/api/scenarios/${record.id}/trigger`, {});
      if (code === 200) {
        message.success(intl.get('场景已触发'));
      }
    } catch (error) {
      console.error('Failed to trigger scenario:', error);
    }
  };

  const handleModalOk = async (values: any) => {
    try {
      if (selectedScenario) {
        const { code } = await request.put('/api/scenarios', values);
        if (code === 200) {
          message.success(intl.get('更新成功'));
          setIsModalVisible(false);
          setSelectedScenario(null);
          fetchScenarios();
        }
      } else {
        const { code } = await request.post('/api/scenarios', values);
        if (code === 200) {
          message.success(intl.get('创建成功'));
          setIsModalVisible(false);
          setSelectedScenario(null);
          fetchScenarios();
        }
      }
    } catch (error) {
      console.error('Failed to save scenario:', error);
      message.error(intl.get('操作失败'));
    }
  };

  const handleViewLogs = (record: any) => {
    setSelectedScenario(record);
    setIsLogModalVisible(true);
  };

  const handleGetWebhook = async (record: any) => {
    try {
      const { code, data } = await request.get(`/api/scenarios/${record.id}/webhook`);
      if (code === 200) {
        Modal.info({
          title: 'Webhook URL',
          content: (
            <div>
              <p>{intl.get('使用此 URL 接收外部触发')}:</p>
              <code style={{ wordBreak: 'break-all' }}>{data.webhookUrl}</code>
            </div>
          ),
          width: 600,
        });
      }
    } catch (error) {
      message.error(intl.get('获取 Webhook URL 失败'));
    }
  };

  const getTriggerTypeName = (type: string) => {
    const types: any = {
      variable: intl.get('变量监听'),
      webhook: 'Webhook',
      task_status: intl.get('任务状态'),
      time: intl.get('时间触发'),
      system_event: intl.get('系统事件'),
    };
    return types[type] || type;
  };

  const getActionsMenu = (record: any): MenuProps => ({
    items: [
      {
        key: 'trigger',
        icon: <PlayCircleOutlined />,
        label: intl.get('手动触发'),
        onClick: () => handleTrigger(record),
      },
      {
        key: 'logs',
        icon: <FileTextOutlined />,
        label: intl.get('查看日志'),
        onClick: () => handleViewLogs(record),
      },
      ...(record.triggerType === 'webhook'
        ? [
            {
              key: 'webhook',
              icon: <LinkOutlined />,
              label: intl.get('获取 Webhook'),
              onClick: () => handleGetWebhook(record),
            },
          ]
        : []),
      {
        type: 'divider' as const,
      },
      {
        key: 'edit',
        icon: <EditOutlined />,
        label: intl.get('编辑'),
        onClick: () => handleEdit(record),
      },
      {
        key: 'delete',
        icon: <DeleteOutlined />,
        label: intl.get('删除'),
        danger: true,
        onClick: () => handleDelete(record),
      },
    ],
  });

  const columns = [
    {
      title: intl.get('名称'),
      dataIndex: 'name',
      key: 'name',
      width: 180,
      ellipsis: true,
    },
    {
      title: intl.get('描述'),
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: intl.get('触发类型'),
      dataIndex: 'triggerType',
      key: 'triggerType',
      width: 120,
      render: (type: string) => (
        <Tag color="blue">{getTriggerTypeName(type)}</Tag>
      ),
    },
    {
      title: intl.get('状态'),
      dataIndex: 'isEnabled',
      key: 'isEnabled',
      width: 80,
      render: (isEnabled: number, record: any) => (
        <Switch
          checked={isEnabled === 1}
          onChange={() => handleToggleEnabled(record)}
        />
      ),
    },
    {
      title: intl.get('执行次数'),
      dataIndex: 'executionCount',
      key: 'executionCount',
      width: 100,
      render: (count: number) => count || 0,
    },
    {
      title: intl.get('成功/失败'),
      key: 'stats',
      width: 100,
      render: (_: any, record: any) => (
        <span>
          <Tag color="success">{record.successCount || 0}</Tag>
          <Tag color="error">{record.failureCount || 0}</Tag>
        </span>
      ),
    },
    {
      title: intl.get('最后触发'),
      dataIndex: 'lastTriggeredAt',
      key: 'lastTriggeredAt',
      width: 160,
      render: (date: string) =>
        date ? dayjs(date).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: intl.get('操作'),
      key: 'action',
      width: 100,
      fixed: 'right' as const,
      render: (_: any, record: any) => (
        <Dropdown menu={getActionsMenu(record)} trigger={['click']}>
          <Button type="link" icon={<EllipsisOutlined />} />
        </Dropdown>
      ),
    },
  ];

  return (
    <PageContainer
      title={intl.get('场景模式')}
      extra={[
        <Button
          key="create"
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleCreate}
        >
          {intl.get('新建场景')}
        </Button>,
      ]}
    >
      <Table
        columns={columns}
        dataSource={scenarios}
        rowKey="id"
        loading={loading}
        scroll={{ x: 1200 }}
        pagination={{
          showSizeChanger: true,
          showTotal: (total) => `${intl.get('共')} ${total} ${intl.get('项')}`,
        }}
      />

      <ScenarioModal
        visible={isModalVisible}
        scenario={selectedScenario}
        onCancel={() => {
          setIsModalVisible(false);
          setSelectedScenario(null);
        }}
        onOk={handleModalOk}
      />

      <ScenarioLogModal
        visible={isLogModalVisible}
        scenario={selectedScenario}
        onCancel={() => {
          setIsLogModalVisible(false);
          setSelectedScenario(null);
        }}
      />
    </PageContainer>
  );
};

export default Scenario;
