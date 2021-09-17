import React, { useEffect, useState } from 'react';
import { Typography, Input, Form, Button, Select, message } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const { Option } = Select;

const NotificationSetting = ({ data }: any) => {
  const [loading, setLoading] = useState(false);
  const [notificationMode, setNotificationMode] = useState<string>('closed');
  const [fields, setFields] = useState<any[]>([]);
  const [form] = Form.useForm();

  const handleOk = (values: any) => {
    if (values.type == 'closed') {
      values.type = '';
    }
    request
      .put(`${config.apiPrefix}user/notification`, {
        data: {
          ...values,
        },
      })
      .then((_data: any) => {
        if (_data && _data.code === 200) {
          message.success(values.type ? '通知发送成功' : '通知关闭成功');
        } else {
          message.error(_data.data);
        }
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const notificationModeChange = (value: string) => {
    setNotificationMode(value);
    const _fields = (config.notificationModeMap as any)[value];
    setFields(_fields || []);
  };

  useEffect(() => {
    if (data && data.type) {
      notificationModeChange(data.type);
      form.setFieldsValue({ ...data });
    }
  }, [data]);

  return (
    <div>
      <Form onFinish={handleOk} form={form} layout="vertical">
        <Form.Item
          label="通知方式"
          name="type"
          rules={[{ required: true }]}
          style={{ maxWidth: 400 }}
          initialValue={notificationMode}
        >
          <Select onChange={notificationModeChange}>
            {config.notificationModes.map((x) => (
              <Option value={x.value}>{x.label}</Option>
            ))}
          </Select>
        </Form.Item>
        {fields.map((x) => (
          <Form.Item
            label={x.label}
            name={x.label}
            extra={x.tip}
            rules={[{ required: x.required }]}
            style={{ maxWidth: 400 }}
          >
            <Input.TextArea autoSize={true} placeholder={`请输入${x.label}`} />
          </Form.Item>
        ))}
        <Button type="primary" htmlType="submit">
          保存
        </Button>
      </Form>
    </div>
  );
};

export default NotificationSetting;
