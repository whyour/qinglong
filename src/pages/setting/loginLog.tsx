import React, { useEffect, useState } from 'react';
import { Typography, Table, Tag, Button, Spin, message } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const { Text, Link } = Typography;

enum LoginStatus {
  '成功',
  '失败',
}

enum LoginStatusColor {
  'success',
  'error',
}

const columns = [
  {
    title: '序号',
    width: 50,
    render: (text: string, record: any, index: number) => {
      return index + 1;
    },
  },
  {
    title: '登录时间',
    dataIndex: 'timestamp',
    key: 'timestamp',
    render: (text: string, record: any) => {
      return new Date(record.timestamp).toLocaleString();
    },
  },
  {
    title: '登录地址',
    dataIndex: 'address',
    key: 'address',
  },
  {
    title: '登录IP',
    dataIndex: 'ip',
    key: 'ip',
  },
  {
    title: '登录设备',
    dataIndex: 'platform',
    key: 'platform',
    width: 80,
  },
  {
    title: '登录状态',
    dataIndex: 'status',
    key: 'status',
    width: 80,
    render: (text: string, record: any) => {
      return (
        <Tag color={LoginStatusColor[record.status]} style={{ marginRight: 0 }}>
          {LoginStatus[record.status]}
        </Tag>
      );
    },
  },
];

const LoginLog = ({ data }: any) => {
  return (
    <>
      <Table
        columns={columns}
        pagination={false}
        dataSource={data}
        rowKey="id"
        size="middle"
        scroll={{ x: 768 }}
        sticky
      />
    </>
  );
};

export default LoginLog;
