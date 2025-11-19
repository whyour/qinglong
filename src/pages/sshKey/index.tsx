import useTableScrollHeight from '@/hooks/useTableScrollHeight';
import { SharedContext } from '@/layouts';
import config from '@/utils/config';
import { request } from '@/utils/http';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-layout';
import { useOutletContext } from '@umijs/max';
import {
  Button,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import intl from 'react-intl-universal';
import { useVT } from 'virtualizedtableforantd4';
import Copy from '../../components/copy';
import SshKeyModal from './modal';

const { Paragraph, Text } = Typography;
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

const SshKey = () => {
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
      title: intl.get('别名'),
      dataIndex: 'alias',
      key: 'alias',
      sorter: (a: any, b: any) => a.alias.localeCompare(b.alias),
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
      width: '35%',
      sorter: (a: any, b: any) => (a.remarks || '').localeCompare(b.remarks || ''),
      render: (text: string, record: any) => {
        return (
          <Tooltip title={text} placement="topLeft">
            <div className="text-ellipsis">{text}</div>
          </Tooltip>
        );
      },
    },
    {
      title: intl.get('状态'),
      key: 'status',
      dataIndex: 'status',
      width: 90,
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
      render: (value: number, record: any) => {
        return <Tag color={StatusColor[value]}>{Status[value]}</Tag>;
      },
    },
    {
      title: intl.get('创建时间'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 185,
      sorter: (a: any, b: any) => {
        return (
          dayjs(a.createdAt || 0).valueOf() - dayjs(b.createdAt || 0).valueOf()
        );
      },
      render: (text: string, record: any) => {
        const d = dayjs(text);
        return d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss') : '-';
      },
    },
    {
      title: intl.get('操作'),
      key: 'action',
      width: 120,
      render: (text: string, record: any, index: number) => {
        return (
          <Space size="middle">
            <Tooltip title={OperationName[record.status]}>
              <a
                onClick={() => {
                  operateSSHKey(
                    [record.id],
                    record.status === 0 ? OperationPath[1] : OperationPath[0],
                  );
                }}
              >
                {OperationName[record.status]}
              </a>
            </Tooltip>
            <Tooltip title={intl.get('编辑')}>
              <a
                onClick={() => {
                  editSSHKey(record);
                }}
              >
                <EditOutlined />
              </a>
            </Tooltip>
            <Tooltip title={intl.get('删除')}>
              <a
                onClick={() => {
                  deleteSSHKey(record);
                }}
              >
                <DeleteOutlined />
              </a>
            </Tooltip>
          </Space>
        );
      },
    },
  ];
  const [value, setValue] = useState<any>();
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const tableRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<any[]>([]);
  const scrollHeight = useTableScrollHeight(tableRef, data, [
    headerStyle.marginTop,
  ]);
  const [vt] = useVT(() => ({ scroll: { y: scrollHeight } }), [scrollHeight]);

  const getSSHKeys = (needLoading = true) => {
    setLoading(needLoading);
    request
      .get(`${config.apiPrefix}sshKeys?searchValue=${searchValue}`)
      .then(({ code, data }) => {
        if (code === 200) {
          setData(data);
        }
      })
      .finally(() => setLoading(false));
  };

  const editSSHKey = (record: any) => {
    setValue(record);
    setIsModalVisible(true);
  };

  const deleteSSHKey = (record: any) => {
    Modal.confirm({
      title: intl.get('确认删除'),
      content: (
        <>
          {intl.get('确认删除SSH密钥')}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.alias}
          </Text>
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}sshKeys`, [record.id])
          .then(({ code, data }) => {
            if (code === 200) {
              message.success(intl.get('删除成功'));
              getSSHKeys();
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const operateSSHKey = (ids: any[], operationPath: string) => {
    request
      .put(`${config.apiPrefix}sshKeys/${operationPath}`, ids)
      .then(({ code, data }) => {
        if (code === 200) {
          message.success(`${intl.get('批量')}${OperationName[OperationPath[operationPath]]}${intl.get('成功')}`);
          getSSHKeys(false);
        }
      });
  };

  const onSearch = (value: string) => {
    setSearchValue(value);
  };

  const handleCancel = (keys?: any[]) => {
    setIsModalVisible(false);
    if (keys) {
      getSSHKeys();
    }
  };

  const addSSHKey = () => {
    setValue(null);
    setIsModalVisible(true);
  };

  useEffect(() => {
    getSSHKeys();
  }, [searchValue]);

  const rowSelection = {
    selectedRowKeys,
    onChange: (selectedRowKeys: React.Key[], selectedRows: any[]) => {
      setSelectedRowKeys(selectedRowKeys);
    },
  };

  return (
    <PageContainer
      className="ql-container-wrapper"
      title={intl.get('SSH密钥')}
      extra={[
        <Button key="1" type="primary" onClick={addSSHKey}>
          {intl.get('新建')}
        </Button>,
      ]}
      header={{
        style: headerStyle,
      }}
    >
      <div ref={tableRef}>
        <Table
          columns={columns}
          rowSelection={rowSelection}
          dataSource={data}
          rowKey="id"
          loading={loading}
          pagination={false}
          scroll={{ x: 768 }}
          sticky
          components={vt}
          size="middle"
        />
      </div>
      {isModalVisible && (
        <SshKeyModal sshKey={value} handleCancel={handleCancel} />
      )}
    </PageContainer>
  );
};

export default SshKey;
