import intl from 'react-intl-universal';
import React from 'react';
import { Table, Tag } from 'antd';
import dayjs from 'dayjs';

enum NotifyStatus {
  '成功',
  '失败',
}

enum NotifyStatusColor {
  'success',
  'error',
}

const columns = [
  {
    title: intl.get('序号'),
    width: 50,
    render: (text: string, record: any, index: number) => {
      return index + 1;
    },
  },
  {
    title: intl.get('发送时间'),
    dataIndex: 'timestamp',
    key: 'timestamp',
    width: 160,
    render: (text: string, record: any) => {
      return dayjs(record.timestamp).format('YYYY-MM-DD HH:mm:ss');
    },
  },
  {
    title: intl.get('标题'),
    dataIndex: 'title',
    key: 'title',
    width: 200,
  },
  {
    title: intl.get('内容'),
    dataIndex: 'content',
    key: 'content',
    render: (text: string) => {
      if (!text) return '';
      return text.length > 100 ? text.slice(0, 100) + '...' : text;
    },
  },
  {
    title: intl.get('推送渠道'),
    dataIndex: 'notifyType',
    key: 'notifyType',
    width: 120,
  },
  {
    title: intl.get('发送状态'),
    dataIndex: 'status',
    key: 'status',
    width: 90,
    render: (text: string, record: any) => {
      return (
        <Tag
          color={NotifyStatusColor[record.status]}
          style={{ marginRight: 0 }}
        >
          {intl.get(NotifyStatus[record.status])}
        </Tag>
      );
    },
  },
];

const NotifyLog = ({
  data,
  height,
}: {
  data: Array<object>;
  height: number;
}) => {
  return (
    <>
      <Table
        columns={columns}
        pagination={false}
        dataSource={data}
        rowKey="id"
        size="middle"
        scroll={{ x: 1000, y: height }}
      />
    </>
  );
};

export default NotifyLog;
