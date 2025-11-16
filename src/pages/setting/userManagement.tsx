import intl from 'react-intl-universal';
import React, { useState, useEffect } from 'react';
import {
  Button,
  Table,
  Space,
  Modal,
  Form,
  Input,
  Select,
  message,
  Tag,
} from 'antd';
import {
  EditOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { request } from '@/utils/http';
import config from '@/utils/config';

const { Option } = Select;

interface User {
  id: number;
  username: string;
  password?: string;
  role: number;
  status: number;
  createdAt: string;
  updatedAt: string;
}

const UserManagement: React.FC<{ height: number }> = ({ height }) => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form] = Form.useForm();

  const columns = [
    {
      title: intl.get('用户名'),
      dataIndex: 'username',
      key: 'username',
    },
    {
      title: intl.get('角色'),
      dataIndex: 'role',
      key: 'role',
      render: (role: number) => (
        <Tag color={role === 0 ? 'red' : 'blue'}>
          {role === 0 ? intl.get('管理员') : intl.get('普通用户')}
        </Tag>
      ),
    },
    {
      title: intl.get('状态'),
      dataIndex: 'status',
      key: 'status',
      render: (status: number) => (
        <Tag color={status === 0 ? 'green' : 'default'}>
          {status === 0 ? intl.get('启用') : intl.get('禁用')}
        </Tag>
      ),
    },
    {
      title: intl.get('创建时间'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (text: string) => text ? new Date(text).toLocaleString() : '-',
    },
    {
      title: intl.get('操作'),
      key: 'action',
      render: (_: any, record: User) => (
        <Space size="middle">
          <Button
            type="link"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            {intl.get('编辑')}
          </Button>
          <Button
            type="link"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete([record.id])}
          >
            {intl.get('删除')}
          </Button>
        </Space>
      ),
    },
  ];

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const { code, data } = await request.get(
        `${config.apiPrefix}user-management`
      );
      if (code === 200) {
        setUsers(data);
      }
    } catch (error) {
      message.error('Failed to fetch users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    setIsModalVisible(true);
  };

  const handleEdit = (record: User) => {
    setEditingUser(record);
    form.setFieldsValue({
      username: record.username,
      role: record.role,
      status: record.status,
    });
    setIsModalVisible(true);
  };

  const handleDelete = (ids: number[]) => {
    Modal.confirm({
      title: intl.get('确认删除'),
      content: intl.get('确认删除选中的用户吗'),
      onOk: async () => {
        try {
          const { code, message: msg } = await request.delete(
            `${config.apiPrefix}user-management`,
            { data: ids }
          );
          if (code === 200) {
            message.success(msg || intl.get('删除成功'));
            fetchUsers();
          } else {
            message.error(msg || intl.get('删除失败'));
          }
        } catch (error: any) {
          message.error(error.message || intl.get('删除失败'));
        }
      },
    });
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      
      if (editingUser) {
        // Update user
        const { code, message: msg } = await request.put(
          `${config.apiPrefix}user-management`,
          { ...values, id: editingUser.id }
        );
        if (code === 200) {
          message.success(msg || intl.get('更新成功'));
          setIsModalVisible(false);
          fetchUsers();
        } else {
          message.error(msg || intl.get('更新失败'));
        }
      } else {
        // Create user
        const { code, message: msg } = await request.post(
          `${config.apiPrefix}user-management`,
          values
        );
        if (code === 200) {
          message.success(msg || intl.get('创建成功'));
          setIsModalVisible(false);
          fetchUsers();
        } else {
          message.error(msg || intl.get('创建失败'));
        }
      }
    } catch (error: any) {
      message.error(error.message || intl.get('操作失败'));
    }
  };

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleAdd}
        >
          {intl.get('新增用户')}
        </Button>
      </div>
      <Table
        columns={columns}
        dataSource={users}
        rowKey="id"
        loading={loading}
        scroll={{ y: height - 120 }}
        pagination={false}
      />
      <Modal
        title={editingUser ? intl.get('编辑用户') : intl.get('新增用户')}
        open={isModalVisible}
        onOk={handleSubmit}
        onCancel={() => setIsModalVisible(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="username"
            label={intl.get('用户名')}
            rules={[{ required: true, message: intl.get('请输入用户名') }]}
          >
            <Input placeholder={intl.get('请输入用户名')} />
          </Form.Item>
          <Form.Item
            name="password"
            label={intl.get('密码')}
            rules={[
              { required: !editingUser, message: intl.get('请输入密码') },
              { min: 6, message: intl.get('密码长度至少为6位') },
            ]}
          >
            <Input.Password placeholder={intl.get('请输入密码')} />
          </Form.Item>
          <Form.Item
            name="role"
            label={intl.get('角色')}
            rules={[{ required: true, message: intl.get('请选择角色') }]}
            initialValue={1}
          >
            <Select>
              <Option value={0}>{intl.get('管理员')}</Option>
              <Option value={1}>{intl.get('普通用户')}</Option>
            </Select>
          </Form.Item>
          <Form.Item
            name="status"
            label={intl.get('状态')}
            rules={[{ required: true, message: intl.get('请选择状态') }]}
            initialValue={0}
          >
            <Select>
              <Option value={0}>{intl.get('启用')}</Option>
              <Option value={1}>{intl.get('禁用')}</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};

export default UserManagement;
