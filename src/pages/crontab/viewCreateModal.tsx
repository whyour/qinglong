import React, { useEffect, useState } from 'react';
import {
  Modal,
  message,
  Input,
  Form,
  Statistic,
  Button,
  Space,
  Select,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';

const PROPERTIES = [
  { name: '命令', value: 'command' },
  { name: '名称', value: 'name' },
  { name: '定时规则', value: 'schedule' },
];

const OPERATIONS = [
  { name: '包含', value: 'contains' },
  { name: '不包含', value: 'noncontains' },
  // { name: '属于', value: 'belong' },
  // { name: '不属于', value: 'nonbelong' },
];

const ViewCreateModal = ({
  view,
  handleCancel,
  visible,
}: {
  view?: any;
  visible: boolean;
  handleCancel: (param?: string) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const method = view ? 'put' : 'post';
    try {
      const { code, data } = await request[method](
        `${config.apiPrefix}crons/views`,
        {
          data: values,
        },
      );
      if (code !== 200) {
        message.error(data);
      }
      setLoading(false);
      handleCancel(data);
    } catch (error: any) {
      setLoading(false);
    }
  };

  useEffect(() => {
    form.resetFields();
    form.setFieldsValue({
      filters: [{ property: 'command', operation: 'contains' }],
    });
  }, [view, visible]);

  const operationElement = (
    <Select style={{ width: 80 }}>
      {OPERATIONS.map((x) => (
        <Select.Option key={x.name} value={x.value}>
          {x.name}
        </Select.Option>
      ))}
    </Select>
  );

  const propertyElement = (
    <Select style={{ width: 100 }}>
      {PROPERTIES.map((x) => (
        <Select.Option key={x.name} value={x.value}>
          {x.name}
        </Select.Option>
      ))}
    </Select>
  );

  return (
    <Modal
      title={view ? '编辑视图' : '新建视图'}
      visible={visible}
      forceRender
      width={580}
      centered
      maskClosable={false}
      onOk={() => {
        form
          .validateFields()
          .then((values) => {
            handleOk(values);
          })
          .catch((info) => {
            console.log('Validate Failed:', info);
          });
      }}
      onCancel={() => handleCancel()}
      confirmLoading={loading}
    >
      <Form form={form} layout="vertical" name="env_modal" initialValues={view}>
        <Form.Item
          name="name"
          label="视图名称"
          rules={[{ required: true, message: '请输入视图名称' }]}
        >
          <Input placeholder="请输入视图名称" />
        </Form.Item>
        <Form.List name="filters">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }, index) => (
                <Form.Item
                  label={index === 0 ? '筛选条件' : ''}
                  required={true}
                  key={key}
                  style={{ marginBottom: 0 }}
                >
                  <Space className="view-create-modal-filters" align="baseline">
                    <Form.Item
                      {...restField}
                      name={[name, 'property']}
                      rules={[{ required: true }]}
                    >
                      {propertyElement}
                    </Form.Item>
                    <Form.Item
                      {...restField}
                      name={[name, 'operation']}
                      rules={[{ required: true }]}
                    >
                      {operationElement}
                    </Form.Item>
                    <Form.Item
                      {...restField}
                      name={[name, 'value']}
                      rules={[{ required: true, message: '请输入内容' }]}
                    >
                      <Input />
                    </Form.Item>
                    {index !== 0 && (
                      <MinusCircleOutlined onClick={() => remove(name)} />
                    )}
                  </Space>
                </Form.Item>
              ))}
              <Form.Item>
                <a
                  href=""
                  onClick={() =>
                    add({ property: 'command', operation: 'contains' })
                  }
                >
                  <PlusOutlined />
                  新增筛选条件
                </a>
              </Form.Item>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
};

export default ViewCreateModal;
