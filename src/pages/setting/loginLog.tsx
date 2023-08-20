import intl from 'react-intl-universal';
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
    title: intl.get('序号'),
    width: 50,
    render: (text: string, record: any, index: number) => {
      return index + 1;
    },
  },
  {
    title: intl.get('登录时间'),
    dataIndex: 'timestamp',
    key: 'timestamp',
    width: 120,
    render: (text: string, record: any) => {
      return new Date(record.timestamp).toLocaleString();
    },
  },
  {
    title: intl.get('登录地址'),
    dataIndex: 'address',
    width: 120,
    key: 'address',
  },
  {
    title: intl.get('登录IP'),
    dataIndex: 'ip',
    width: 100,
    key: 'ip',
  },
  {
    title: intl.get('登录设备'),
    dataIndex: 'platform',
    key: 'platform',
    width: 80,
  },
  {
    title: intl.get('登录状态'),
    dataIndex: 'status',
    key: 'status',
    width: 80,
    render: (text: string, record: any) => {
      return (
        <Tag color={LoginStatusColor[record.status]} style={{ marginRight: 0 }}>
          {intl.get(LoginStatus[record.status])}
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
        scroll={{ x: 1000 }}
        sticky
      />
    </>
  );
};

export default LoginLog;
