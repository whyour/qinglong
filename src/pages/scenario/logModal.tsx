import React, { useEffect, useState } from 'react';
import { Modal, Table, Tag, Typography } from 'antd';
import { request } from '@/utils/http';
import intl from 'react-intl-universal';
import dayjs from 'dayjs';

const { Text } = Typography;

interface ScenarioLogModalProps {
  visible: boolean;
  scenario: any;
  onCancel: () => void;
}

const ScenarioLogModal: React.FC<ScenarioLogModalProps> = ({
  visible,
  scenario,
  onCancel,
}) => {
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);

  useEffect(() => {
    if (visible && scenario) {
      fetchLogs();
    }
  }, [visible, scenario]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const { code, data } = await request.get('/api/scenarios/logs', {
        params: {
          scenarioId: scenario.id,
          limit: 100,
        },
      });
      if (code === 200) {
        setLogs(data || []);
      }
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: intl.get('时间'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (date: string) => dayjs(date).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: intl.get('状态'),
      dataIndex: 'executionStatus',
      key: 'executionStatus',
      width: 100,
      render: (status: string) => {
        const colors: any = {
          success: 'success',
          failure: 'error',
          partial: 'warning',
        };
        return <Tag color={colors[status] || 'default'}>{status}</Tag>;
      },
    },
    {
      title: intl.get('条件匹配'),
      dataIndex: 'conditionsMatched',
      key: 'conditionsMatched',
      width: 100,
      render: (matched: boolean) => (
        <Tag color={matched ? 'success' : 'default'}>
          {matched ? intl.get('是') : intl.get('否')}
        </Tag>
      ),
    },
    {
      title: intl.get('执行时间'),
      dataIndex: 'executionTime',
      key: 'executionTime',
      width: 100,
      render: (time: number) => (time ? `${time}ms` : '-'),
    },
    {
      title: intl.get('重试次数'),
      dataIndex: 'retriesAttempted',
      key: 'retriesAttempted',
      width: 100,
      render: (retries: number) => retries || 0,
    },
    {
      title: intl.get('错误信息'),
      dataIndex: 'errorMessage',
      key: 'errorMessage',
      ellipsis: true,
      render: (error: string) => (
        <Text type={error ? 'danger' : undefined}>{error || '-'}</Text>
      ),
    },
  ];

  return (
    <Modal
      title={`${intl.get('场景日志')} - ${scenario?.name || ''}`}
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={1000}
      destroyOnClose
    >
      <Table
        columns={columns}
        dataSource={logs}
        rowKey="id"
        loading={loading}
        pagination={{
          pageSize: 20,
          showSizeChanger: true,
        }}
        size="small"
      />
    </Modal>
  );
};

export default ScenarioLogModal;
