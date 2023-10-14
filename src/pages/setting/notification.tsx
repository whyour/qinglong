import intl from 'react-intl-universal';
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
    setLoading(true);
    const { type } = values;
    if (type == 'closed') {
      values.type = '';
    }

    request
      .put(`${config.apiPrefix}user/notification`, values)
      .then(({ code, data }) => {
        if (code === 200) {
          message.success(
            values.type ? intl.get('通知发送成功') : intl.get('通知关闭成功'),
          );
        }
      })
      .catch((error: any) => {
        console.log(error);
      })
      .finally(() => setLoading(false));
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
          label={intl.get('通知方式')}
          name="type"
          rules={[{ required: true }]}
          style={{ maxWidth: 400 }}
          initialValue={notificationMode}
        >
          <Select onChange={notificationModeChange} disabled={loading}>
            {config.notificationModes.map((x) => (
              <Option key={x.value} value={x.value}>
                {x.label}
              </Option>
            ))}
          </Select>
        </Form.Item>
        {fields.map((x) => (
          <Form.Item
            key={x.label}
            label={x.label}
            name={x.label}
            extra={x.tip}
            rules={[{ required: x.required }]}
            style={{ maxWidth: 400 }}
          >
            {x.items ? (
              <Select
                placeholder={x.placeholder || `${intl.get('请选择')} ${x.label}`}
                disabled={loading}
              >
                {x.items.map((y) => (
                  <Option key={y.value} value={y.value}>
                    {y.label || y.value}
                  </Option>
                ))}
              </Select>
            ) : (
              <Input.TextArea
                disabled={loading}
                autoSize={{ minRows: 1, maxRows: 5 }}
                placeholder={x.placeholder || `${intl.get('请输入')} ${x.label}`}
              />
            )}
          </Form.Item>
        ))}
        <Button type="primary" htmlType="submit" disabled={loading}>
          {loading ? intl.get('测试中...') : intl.get('保存')}
        </Button>
      </Form>
    </div>
  );
};

export default NotificationSetting;
